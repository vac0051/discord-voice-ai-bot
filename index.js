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
const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// DisTube imports
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ] 
});

const ffmpegPath = require('ffmpeg-static');

const distube = new DisTube(client, {
    plugins: [new SoundCloudPlugin()],
    emitNewSongOnly: true,
    ffmpeg: {
        path: ffmpegPath
    }
});

let textChannel = null;
const activeStreams = new Set();

client.on(Events.ClientReady, () => {
    console.log(`[NodeBot] Запущен как ${client.user.tag}!`);
});

// DisTube events
distube.on('playSong', (queue, song) => {
    if (textChannel) {
        textChannel.send(`🎵 **Включаю:** \`${song.name}\` - \`${song.formattedDuration}\`\nСсылка: ${song.url}`);
    }
    // Отключаем selfDeaf при начале проигрывания песни на всякий случай
    try {
        const voice = distube.voices.get(queue.textChannel.guild.id);
        if (voice) {
            voice.setSelfDeaf(false);
            console.log(`[NodeBot] PlaySong: Принудительно отключен selfDeaf для постоянного прослушивания`);
        }
    } catch (e) {
        console.error(`[NodeBot] PlaySong: Не удалось отключить selfDeaf:`, e);
    }
});
distube.on('addSong', (queue, song) => {
    if (textChannel) {
        textChannel.send(`✅ **Добавлено в очередь:** \`${song.name}\``);
    }
});
distube.on('initQueue', (queue) => {
    queue.autoplay = true;
    console.log(`[NodeBot] Инициализирована очередь, автоплей (рекомендации) ВКЛЮЧЕН по умолчанию`);
});
distube.on('error', (error, queue, song) => {
    console.error('[DisTube Error]', error);
    const targetChannel = queue?.textChannel || textChannel;
    if (targetChannel && typeof targetChannel.send === 'function') {
        const errorMsg = error?.message || String(error);
        targetChannel.send(`❌ Возникла ошибка: ${errorMsg.slice(0, 2000)}`).catch(console.error);
    }
});

function findTextChannel(guild) {
    let ch = guild.channels.cache.get('1509215578622267444');
    if (ch) return ch;

    ch = guild.channels.cache.find(ch => 
        ch.isTextBased() && 
        ch.permissionsFor(guild.members.me).has('SendMessages')
    );
    return ch;
}

async function joinChannel(channel, textChan) {
    console.log(`[NodeBot] Попытка подключения к "${channel.name}" через DisTube...`);
    textChannel = textChan;
    
    // Используем DisTube для подключения, чтобы он управлял соединением
    const voice = await distube.voices.join(channel);
    try {
        voice.setSelfDeaf(false);
        console.log(`[NodeBot] Отключен selfDeaf для получения аудио пакетов`);
    } catch (e) {
        console.error(`[NodeBot] Не удалось установить selfDeaf в false:`, e);
    }
    const connection = voice.connection;
    
    if (textChannel) {
        textChannel.send(`✅ **[Алиса]** Я здесь.`);
    }
    
    // Слушаем речь
    connection.receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return;
        activeStreams.add(userId);
        
        const user = client.users.cache.get(userId);
        const userName = user ? user.username : userId;
        
        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });
        
        const timestamp = Date.now();
        const pcmPath = path.join(__dirname, `user_${userId}_${timestamp}.pcm`);
        const pcmWavPath = path.join(__dirname, `user_${userId}_${timestamp}.wav`);
        
        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const filterStream = new Transform({
            transform(chunk, encoding, callback) {
                const dave = connection.state.networking?.state?.dave;
                if (dave && dave.session) {
                    try { dave.session.setPassthroughMode(true, 999999); } catch (e) {}
                }
                this.push(chunk);
                callback();
            }
        });

        const writeStream = fs.createWriteStream(pcmPath);
        
        audioStream.pipe(filterStream).pipe(opusDecoder).pipe(writeStream);
        
        writeStream.on('finish', () => {
            activeStreams.delete(userId);
            
            if (!fs.existsSync(pcmPath)) return;
            const stats = fs.statSync(pcmPath);
            if (stats.size < 100) {
                try { fs.unlinkSync(pcmPath); } catch(e){}
                return;
            }
            
            const ffmpegPath = require('ffmpeg-static');
            const ffmpegProcess = spawn(ffmpegPath, [
                '-y', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath,
                '-f', 'wav', '-ar', '16000', '-ac', '1', pcmWavPath
            ]);
            
            ffmpegProcess.on('close', (code) => {
                try { fs.unlinkSync(pcmPath); } catch(e){}
                if (code !== 0 || !fs.existsSync(pcmWavPath)) return;
                
                const pythonProcess = spawn('python', [
                    path.join(__dirname, 'process_audio.py'),
                    pcmWavPath
                ], {
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: 'utf-8'
                    }
                });
            
                pythonProcess.stdout.on('data', async (data) => {
                    const lines = data.toString().split('\n');
                    const debugChannel = client.channels.cache.get('1509215578622267444');
                    
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        console.log(`[Python] ${line}`);
                        
                        if (line.startsWith('TEXT:')) {
                            const text = line.substring(5).trim();
                            if (text && debugChannel) await debugChannel.send(`🗣️ \`${userName}\` сказал: ${text}`);
                        } else if (line.startsWith('MUSIC:')) {
                            const query = line.substring(6).trim();
                            if (query) {
                                if (debugChannel) await debugChannel.send(`🎵 Распознана команда на музыку: ${query}`);
                                const guild = client.guilds.cache.get(channel.guild.id);
                                const member = guild.members.cache.get(userId);
                                if (member && member.voice.channel) {
                                    distube.play(member.voice.channel, query, {
                                        member: member,
                                        textChannel: textChannel
                                    });
                                }
                            }
                        } else if (line.startsWith('STOP:')) {
                            if (debugChannel) await debugChannel.send(`🛑 Получена голосовая команда на выключение музыки`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue) {
                                    queue.stop();
                                    if (textChannel) await textChannel.send(`🛑 **[Алиса]** Музыка выключена по голосовой команде.`);
                                } else {
                                    if (textChannel) await textChannel.send(`ℹ️ **[Алиса]** Сейчас ничего не играет.`);
                                }
                            } catch (e) {
                                console.error(`[NodeBot] Ошибка остановки музыки по голосу:`, e);
                            }
                        } else if (line.startsWith('PAUSE:')) {
                            if (debugChannel) await debugChannel.send(`⏸️ Получена голосовая команда на паузу`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue && !queue.paused) {
                                    queue.pause();
                                    if (textChannel) await textChannel.send(`⏸️ **[Алиса]** Музыка поставлена на паузу.`);
                                }
                            } catch (e) {
                                console.error(`[NodeBot] Ошибка паузы по голосу:`, e);
                            }
                        } else if (line.startsWith('RESUME:')) {
                            if (debugChannel) await debugChannel.send(`▶️ Получена голосовая команда на возобновление`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue && queue.paused) {
                                    queue.resume();
                                    if (textChannel) await textChannel.send(`▶️ **[Алиса]** Воспроизведение возобновлено.`);
                                }
                            } catch (e) {
                                console.error(`[NodeBot] Ошибка возобновления по голосу:`, e);
                            }
                        } else if (line.startsWith('SKIP:')) {
                            if (debugChannel) await debugChannel.send(`⏭️ Получена голосовая команда на пропуск трека`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue) {
                                    if (queue.songs.length === 1) queue.stop();
                                    else queue.skip();
                                    if (textChannel) await textChannel.send(`⏭️ **[Алиса]** Текущий трек пропущен.`);
                                }
                            } catch (e) {
                                console.error(`[NodeBot] Ошибка пропуска по голосу:`, e);
                            }
                        } else if (line.startsWith('AUTOPLAY:')) {
                            if (debugChannel) await debugChannel.send(`📻 Получена голосовая команда на автоплей`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue) {
                                    const autoplay = queue.toggleAutoplay();
                                    if (textChannel) await textChannel.send(`📻 **[Алиса]** Автовоспроизведение рекомендаций теперь **${autoplay ? 'ВКЛЮЧЕНО' : 'ВЫКЛЮЧЕНО'}**.`);
                                }
                            } catch (e) {
                                console.error(`[NodeBot] Ошибка переключения автоплея по голосу:`, e);
                            }
                        } else if (line.startsWith('IGNORING:')) {
                            if (debugChannel) await debugChannel.send(`🛑 Игнорирую: ${line}`);
                        } else if (line.startsWith('ERROR:')) {
                            if (debugChannel) await debugChannel.send(`❌ Ошибка Python: ${line}`);
                        }
                    }
                });
                
                pythonProcess.stderr.on('data', async (data) => {
                    console.error(`[Python Stderr] ${data}`);
                    const debugChannel = client.channels.cache.get('1509215578622267444');
                    if (debugChannel) await debugChannel.send(`⚠️ Ошибка (stderr): ${data.toString().slice(0, 1900)}`);
                });
                
                pythonProcess.on('close', () => {
                    try { fs.unlinkSync(pcmWavPath); } catch(e){}
                });
            });
        });
        audioStream.on('error', (err) => console.error(`[NodeBot AudioStream Error]`, err.message));
        filterStream.on('error', (err) => console.error(`[NodeBot FilterStream Error]`, err.message));
        opusDecoder.on('error', (err) => console.error(`[NodeBot OpusDecoder Error]`, err.message));
        
        writeStream.on('error', (err) => {
            console.error(`[NodeBot WriteStream Error]`, err.message);
            activeStreams.delete(userId);
            try { fs.unlinkSync(pcmWavPath); } catch(e){}
        });
    });
    
    return voice;
}

client.on(Events.MessageCreate, async message => {
    if (!message.guild || message.author.bot) return;
    
    const args = message.content.trim().split(/ +/g);
    const command = args.shift().toLowerCase();
    
    if (command === '!play' || command === '!p') {
        const query = args.join(' ');
        if (!query) return message.reply('Укажите что искать (например, !play Rammstein или !p Rammstein)');
        
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) return message.reply('Вы должны быть в голосовом канале!');
        
        try {
            // Подключаемся к голосовому каналу и настраиваем слушатель речи
            await joinChannel(voiceChannel, message.channel);
            
            await distube.play(voiceChannel, query, {
                message,
                textChannel: message.channel,
                member: message.member,
            });
        } catch (e) {
            console.error(e);
            message.reply(`Ошибка: ${e.message}`);
        }
    } else if (command === '!stop') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        queue.stop();
        message.reply('Остановлено.');
    } else if (command === '!skip' || command === '!s') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        try {
            if (queue.songs.length === 1) queue.stop();
            else queue.skip();
            message.reply('Пропущено.');
        } catch (e) {
            message.reply(`${e}`);
        }
    } else if (command === '!pause') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        if (queue.paused) return message.reply('Музыка уже на паузе.');
        queue.pause();
        message.reply('Приостановлено.');
    } else if (command === '!resume' || command === '!unpause') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        if (!queue.paused) return message.reply('Музыка уже играет.');
        queue.resume();
        message.reply('Возобновлено.');
    } else if (command === '!autoplay' || command === '!ap') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        const autoplay = queue.toggleAutoplay();
        message.reply(`Рекомендации (автовоспроизведение) теперь: **${autoplay ? 'ВКЛЮЧЕНЫ' : 'ВЫКЛЮЧЕНЫ'}**.`);
    } else if (command === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinChannel(voiceChannel, message.channel);
        } else {
            message.reply('Вы должны находиться в голосовом канале!');
        }
    } else if (command === '!leave') {
        distube.voices.leave(message.guild);
        message.reply('Отключилась.');
    }
});

// Auto-join and Auto-leave events
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const member = newState.member;
    if (!member) return;
    
    // Игнорируем самого себя
    if (member.id === client.user.id) {
        return;
    }
    
    // Игнорируем других ботов
    if (member.user.bot) return;
    
    const oldChannel = oldState.channel;
    const newChannel = newState.channel;
    
    // --- Юзер зашел в голосовой канал ---
    if (newChannel && !oldChannel) {
        // Если бот еще не подключен в этой гильдии
        const voice = distube.voices.get(newState.guild.id);
        if (!voice) {
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
        const voice = distube.voices.get(newState.guild.id);
        if (voice) {
            const botChannel = voice.connection.joinConfig.channelId;
            if (oldChannel.id === botChannel) {
                // Если бот был в старом канале и там не осталось людей (кроме ботов)
                const realInOld = oldChannel.members.filter(m => !m.user.bot);
                if (realInOld.size === 0) {
                    console.log(`[NodeBot] В старом канале ${oldChannel.name} не осталось людей. Переходим за ${member.user.username} в ${newChannel.name}...`);
                    const txtChan = findTextChannel(newChannel.guild);
                    
                    try {
                        distube.voices.leave(newState.guild);
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
        const voice = distube.voices.get(newState.guild.id);
        if (voice) {
            const botChannel = voice.connection.joinConfig.channelId;
            if (oldChannel.id === botChannel) {
                // Проверяем, остались ли люди
                const realRemaining = oldChannel.members.filter(m => !m.user.bot);
                if (realRemaining.size === 0) {
                    console.log(`[NodeBot] В канале ${oldChannel.name} не осталось людей. Отключаемся...`);
                    try {
                        distube.voices.leave(newState.guild);
                    } catch (e) {
                        console.error('[NodeBot] Ошибка при отключении:', e);
                    }
                }
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
