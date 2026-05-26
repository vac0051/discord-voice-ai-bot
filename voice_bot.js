// Force IPv4 resolution to prevent "RTC Connecting" hangs on VDS servers with broken/local-only IPv6 routing
const dns = require('dns');
const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    } else if (typeof options === 'number') {
        options = { family: options };
    } else if (!options) {
        options = {};
    }
    options.family = 4;
    return originalLookup.call(this, hostname, options, callback);
};
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
}

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    EndBehaviorType,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ] 
});

const player = createAudioPlayer();
let textChannel = null;
let currentConnection = null;
let currentPlayingMp3 = null;
const activeStreams = new Set(); // To prevent overlapping subscriptions for the same user

client.on(Events.ClientReady, () => {
    console.log(`[NodeBot] Запущен как ${client.user.tag}!`);
});

// Helper function to find a text channel where the bot has send permissions
function findTextChannel(guild) {
    const ch = guild.channels.cache.find(ch => 
        ch.isTextBased() && 
        ch.permissionsFor(guild.members.me).has('SendMessages')
    );
    if (ch) {
        console.log(`[NodeBot] Найден текстовый канал для логов: #${ch.name}`);
    } else {
        console.log(`[NodeBot] ⚠️ Не найден подходящий текстовый канал для логов в гильдии ${guild.name}`);
    }
    return ch;
}

// Main function to join voice channel and set up audio receiving
function joinChannel(channel, textChan) {
    console.log(`[NodeBot] Попытка подключения к каналу "${channel.name}" (ID: ${channel.id}) в гильдии "${channel.guild.name}"...`);
    textChannel = textChan;
    
    // If there is an existing connection, destroy it first
    if (currentConnection) {
        console.log(`[NodeBot] Обнаружено существующее голосовое подключение. Уничтожаем его...`);
        try {
            currentConnection.destroy();
        } catch (e) {
            console.error(`[NodeBot] Ошибка при уничтожении старого подключения:`, e);
        }
    }
    
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        debug: true
    });
    
    currentConnection = connection;
    connection.subscribe(player);
    
    console.log(`[NodeBot] Создано подключение joinVoiceChannel. Начинаем слушать статусы подключения...`);
    
    connection.on('stateChange', (oldState, newState) => {
        console.log(`[NodeBot Connection State] ${oldState.status} -> ${newState.status}`);
    });
    
    // Включаем внутренний дебаг @discordjs/voice
    connection.on('debug', (msg) => {
        console.log(`[NodeBot Voice Debug] ${msg}`);
    });
    
    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[NodeBot] Успешно подключился к каналу: ${channel.name} и готов к воспроизведению/приему!`);
        if (textChannel) {
            textChannel.send(`✅ **[NodeBot]** Подключился с поддержкой DAVE. Готов слушать (триггер: \`кирилл\`).`);
        }
        
        // Решение Silent Bot Bug: проигрываем приветствие для активации связи
        const welcomeMp3 = path.join(__dirname, 'welcome.mp3');
        const welcomeText = 'Привет! Я готов слушать. Спросите меня о Доте, начав вопрос со слова Кирилл.';
        
        console.log(`[NodeBot] Генерация приветственного аудио...`);
        const ttsProcess = spawn('/root/botparsecdota2/venv_voice/bin/python', [
            path.join(__dirname, 'tts_helper.py'),
            welcomeText,
            welcomeMp3
        ]);
        
        ttsProcess.on('close', (code) => {
            if (code === 0 && fs.existsSync(welcomeMp3)) {
                console.log(`[NodeBot] Воспроизведение приветственного файла для активации связи...`);
                currentPlayingMp3 = welcomeMp3;
                const resource = createAudioResource(welcomeMp3);
                player.play(resource);
            } else {
                console.error(`[NodeBot] ⚠️ Не удалось сгенерировать приветственный файл. Код выхода: ${code}`);
            }
        });
    });
    
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        console.log(`[NodeBot] Получен статус Disconnected. Пробуем переподключиться...`);
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
            console.log(`[NodeBot] Переподключение успешно!`);
        } catch (error) {
            console.log(`[NodeBot] Не удалось восстановить подключение. Уничтожаем объект соединения.`);
            try {
                connection.destroy();
            } catch (e) {}
            if (currentConnection === connection) {
                currentConnection = null;
            }
        }
    });
    
    connection.on('error', (err) => {
        console.error(`[NodeBot Connection Error]`, err);
    });
    
    // Настройка приема аудио
    connection.receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) {
            return; // Already listening to this user's current speech stream
        }
        activeStreams.add(userId);
        
        const user = client.users.cache.get(userId);
        const userName = user ? user.username : userId;
        console.log(`[NodeBot] 🎤 Слышу голос от ${userName}`);
        
        // Создаем аудиопоток (Opus)
        const audioStream = connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000,
            },
        });
        
        // Временные файлы для записи PCM и итогового WAV
        const timestamp = Date.now();
        const pcmPath = path.join(__dirname, `user_${userId}_${timestamp}.pcm`);
        const pcmWavPath = path.join(__dirname, `user_${userId}_${timestamp}.wav`);
        
        // Opus -> PCM
        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        
        // Filter stream to drop packets while DAVE E2EE is not yet ready
        const filterStream = new Transform({
            transform(chunk, encoding, callback) {
                const dave = connection.state.networking?.state?.dave;
                if (dave && dave.session) {
                    try {
                        // Force passthrough mode to allow unencrypted packets (which Discord clients often send)
                        dave.session.setPassthroughMode(true, 999999);
                    } catch (e) {
                        console.error('[NodeBot] Error setting passthrough:', e.message);
                    }
                }
                // Always pass the packet. If it's decrypted or unencrypted, it's valid Opus.
                this.push(chunk);
                callback();
            }
        });

        const writeStream = fs.createWriteStream(pcmPath);
        
        // Add error handlers to prevent unhandled stream errors from crashing the bot
        audioStream.on('error', (err) => console.error(`[NodeBot AudioStream Error]`, err.message));
        filterStream.on('error', (err) => console.error(`[NodeBot FilterStream Error]`, err.message));
        opusDecoder.on('error', (err) => console.error(`[NodeBot OpusDecoder Error]`, err.message));
        writeStream.on('error', (err) => console.error(`[NodeBot WriteStream Error]`, err.message));
        
        // Add data logs for debugging
        audioStream.on('data', (chunk) => {
            console.log(`[NodeBot AudioStream] Received packet: ${chunk.length} bytes`);
        });
        filterStream.on('data', (chunk) => {
            console.log(`[NodeBot FilterStream] Passed packet: ${chunk.length} bytes`);
        });
        opusDecoder.on('data', (chunk) => {
            console.log(`[NodeBot OpusDecoder] Decoded PCM chunk: ${chunk.length} bytes`);
        });
        
        // Opus -> Filter -> PCM -> WAV file on disk
        audioStream.pipe(filterStream).pipe(opusDecoder).pipe(writeStream);
        
        writeStream.on('finish', () => {
            console.log(`[NodeBot] 🔇 ${userName} замолчал. Запись PCM файла полностью завершена: ${pcmPath}`);
            activeStreams.delete(userId);
            
            if (!fs.existsSync(pcmPath)) {
                console.log(`[NodeBot] ⚠️ PCM Файл не найден: ${pcmPath}`);
                return;
            }
            
            const stats = fs.statSync(pcmPath);
            if (stats.size < 100) {
                console.log(`[NodeBot] ⚠️ PCM Файл слишком маленький (${stats.size} байт), возможно шум. Пропускаем.`);
                try { fs.unlinkSync(pcmPath); } catch(e){}
                return;
            }
            
            console.log(`[NodeBot] Конвертируем PCM (${stats.size} байт) в WAV с помощью FFmpeg...`);
            
            // Запускаем FFmpeg для конвертации PCM -> WAV на диске
            const ffmpegProcess = spawn('ffmpeg', [
                '-y',
                '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath,
                '-f', 'wav', '-ar', '16000', '-ac', '1', pcmWavPath
            ]);
            
            ffmpegProcess.on('close', (code) => {
                // Всегда удаляем временный PCM файл
                try { fs.unlinkSync(pcmPath); } catch(e){}
                
                if (code !== 0 || !fs.existsSync(pcmWavPath)) {
                    console.error(`[NodeBot] ⚠️ Ошибка FFmpeg при конвертации PCM -> WAV. Код: ${code}`);
                    try { fs.unlinkSync(pcmWavPath); } catch(e){}
                    return;
                }
                
                const wavStats = fs.statSync(pcmWavPath);
                console.log(`[NodeBot] Успешно сконвертировано в WAV: ${pcmWavPath} (${wavStats.size} байт)`);
                
                console.log(`[NodeBot] Запуск ML обработки для ${pcmWavPath} (${wavStats.size} байт)`);
                
                // Запускаем Python скрипт (используем venv_voice)
                const pythonProcess = spawn('/root/botparsecdota2/venv_voice/bin/python', [
                    path.join(__dirname, 'process_audio.py'),
                    pcmWavPath
                ]);
            
            pythonProcess.stdout.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    console.log(`[Python]: ${line}`);
                    
                    if (line.startsWith('TEXT:')) {
                        const text = line.substring(5).trim();
                        if (text && textChannel) textChannel.send(`🗣️ **[Дебаг Vosk]** \`${userName}\`: ${text}`);
                    } else if (line.startsWith('REPLY:')) {
                        const reply = line.substring(6).trim();
                        if (reply && textChannel) textChannel.send(`💬 **[Ответ ИИ]**: ${reply}`);
                    } else if (line.startsWith('MP3:')) {
                        const mp3Path = line.substring(4).trim();
                        console.log(`[NodeBot] Воспроизведение ${mp3Path}`);
                        currentPlayingMp3 = mp3Path;
                        const resource = createAudioResource(mp3Path);
                        player.play(resource);
                    }
                }
            });
            
            pythonProcess.stderr.on('data', (data) => {
                console.error(`[Python Error]: ${data}`);
            });
            
            pythonProcess.on('close', () => {
                // Удаляем WAV
                try { fs.unlinkSync(pcmWavPath); } catch(e){}
            });
        });
    });
        
        writeStream.on('error', (err) => {
            console.error(`[NodeBot WriteStream Error]`, err);
            activeStreams.delete(userId);
            try { fs.unlinkSync(pcmWavPath); } catch(e){}
        });
    });
    
    return connection;
}

client.on(Events.MessageCreate, async message => {
    if (!message.guild) return;
    
    if (message.content.startsWith('!')) {
        console.log(`[NodeBot Command] Получена команда: "${message.content}" от пользователя: ${message.author.username}`);
    }
    
    if (message.content === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinChannel(voiceChannel, message.channel);
        } else {
            console.log(`[NodeBot Command] ⚠️ Пользователь ${message.author.username} вызвал !join, но не находится в голосовом канале.`);
            message.reply('Вы должны находиться в голосовом канале!');
        }
    } else if (message.content === '!leave') {
        if (currentConnection) {
            try {
                currentConnection.destroy();
            } catch (e) {}
            currentConnection = null;
            message.reply('✅ Отключился.');
        } else {
            message.reply('Я не подключен к голосовому каналу!');
        }
    }
});

// Auto-join and Auto-leave events
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const member = newState.member;
    if (!member) return;
    
    // Игнорируем самого себя
    if (member.id === client.user.id) {
        console.log(`[NodeBot Self Voice State] ${oldState.channelId || 'None'} -> ${newState.channelId || 'None'}`);
        if (oldState.channelId && !newState.channelId) {
            console.log('[NodeBot] Бот был отключен от голосового канала');
            currentConnection = null;
        }
        return;
    }
    
    // Игнорируем других ботов
    if (member.user.bot) return;
    
    const oldChannel = oldState.channel;
    const newChannel = newState.channel;
    
    console.log(`[NodeBot VoiceStateUpdate] User: ${member.user.username} | ${oldChannel ? oldChannel.name : 'None'} -> ${newChannel ? newChannel.name : 'None'}`);
    
    // --- Юзер зашел в голосовой канал ---
    if (newChannel && !oldChannel) {
        // Если бот еще не подключен в этой гильдии
        if (!currentConnection) {
            const realMembers = newChannel.members.filter(m => !m.user.bot);
            if (realMembers.size >= 1) {
                console.log(`[NodeBot] Пользователь ${member.user.username} вошел в ${newChannel.name}, автоподключение...`);
                const txtChan = findTextChannel(newChannel.guild);
                joinChannel(newChannel, txtChan);
            }
        }
    }
    
    // --- Юзер перешел в другой канал ---
    else if (newChannel && oldChannel && newChannel.id !== oldChannel.id) {
        if (currentConnection) {
            const botChannel = currentConnection.joinConfig.channelId;
            if (oldChannel.id === botChannel) {
                // Если бот был в старом канале и там не осталось людей (кроме ботов)
                const realInOld = oldChannel.members.filter(m => !m.user.bot);
                if (realInOld.size === 0) {
                    console.log(`[NodeBot] В старом канале ${oldChannel.name} не осталось людей. Переходим за ${member.user.username} в ${newChannel.name}...`);
                    const txtChan = findTextChannel(newChannel.guild);
                    
                    // Отключаемся и подключаемся к новому
                    try {
                        currentConnection.destroy();
                        currentConnection = null;
                        await new Promise(resolve => setTimeout(resolve, 500));
                        joinChannel(newChannel, txtChan);
                    } catch (e) {
                        console.error('[NodeBot] Ошибка при смене канала:', e);
                    }
                }
            }
        }
    }
    
    // --- Юзер вышел из голосового канала ---
    else if (!newChannel && oldChannel) {
        if (currentConnection) {
            const botChannel = currentConnection.joinConfig.channelId;
            if (oldChannel.id === botChannel) {
                // Проверяем, остались ли люди
                const realRemaining = oldChannel.members.filter(m => !m.user.bot);
                if (realRemaining.size === 0) {
                    console.log(`[NodeBot] В канале ${oldChannel.name} не осталось людей. Отключаемся...`);
                    try {
                        currentConnection.destroy();
                        currentConnection = null;
                    } catch (e) {
                        console.error('[NodeBot] Ошибка при отключении:', e);
                    }
                }
            }
        }
    }
});

player.on(AudioPlayerStatus.Idle, () => {
    console.log('[NodeBot] Воспроизведение завершено');
    if (currentPlayingMp3) {
        try {
            fs.unlinkSync(currentPlayingMp3);
            console.log(`[NodeBot] Удален временный MP3 файл: ${currentPlayingMp3}`);
        } catch (e) {
            console.error(`[NodeBot] Ошибка удаления MP3 файла: ${e.message}`);
        }
        currentPlayingMp3 = null;
    }
});

player.on('error', error => {
    console.error('[NodeBot] Ошибка плеера:', error.message);
});

client.login(process.env.DISCORD_TOKEN);
