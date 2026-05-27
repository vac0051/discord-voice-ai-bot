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

const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');
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
const { YtDlpPlugin } = require('@distube/yt-dlp');

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
    plugins: [
        new SoundCloudPlugin(),
        new YtDlpPlugin()
    ],
    emitNewSongOnly: true,
    ffmpeg: {
        path: ffmpegPath
    }
});

// Per-guild settings store
const guildSettings = new Map();

function getSettings(guildId) {
    if (!guildSettings.has(guildId)) {
        guildSettings.set(guildId, {
            searchSource: 'sc', // default: sc (SoundCloud) or yt (YouTube)
            autoplay: true,
            debugLogs: true
        });
    }
    return guildSettings.get(guildId);
}

function buildSettingsEmbed(guildId) {
    const settings = getSettings(guildId);
    return new EmbedBuilder()
        .setTitle('🎙️ Настройки голосового помощника Алисы')
        .setDescription('Здесь вы можете изменить источник поиска музыки, автовоспроизведение рекомендаций и логирование дебага.')
        .setColor(0x9b59b6)
        .addFields(
            { name: '🔍 Источник поиска по тексту/голосу', value: settings.searchSource === 'yt' ? '🔴 **YouTube** (через yt-dlp)' : '🟠 **SoundCloud**', inline: true },
            { name: '📻 Автоплей рекомендаций', value: settings.autoplay ? '🟢 **Включен** (авто-подбор треков)' : '🔴 **Выключен**', inline: true },
            { name: '🛠️ Отправка дебаг логов в чат', value: settings.debugLogs ? '🟢 **Включена** (в канал `#debug`)' : '🔴 **Выключена**', inline: true }
        )
        .setFooter({ text: 'Алиса • Управление музыкой' });
}

function buildSettingsButtons(guildId) {
    const settings = getSettings(guildId);
    
    const autoplayBtn = new ButtonBuilder()
        .setCustomId(`toggle_autoplay_${guildId}`)
        .setLabel(settings.autoplay ? '📻 Автоплей: Вкл' : '📻 Автоплей: Выкл')
        .setStyle(settings.autoplay ? ButtonStyle.Success : ButtonStyle.Danger);
        
    const debugBtn = new ButtonBuilder()
        .setCustomId(`toggle_debug_${guildId}`)
        .setLabel(settings.debugLogs ? '🛠️ Дебаг Логи: Вкл' : '🛠️ Дебаг Логи: Выкл')
        .setStyle(settings.debugLogs ? ButtonStyle.Success : ButtonStyle.Danger);

    return new ActionRowBuilder().addComponents(autoplayBtn, debugBtn);
}

function buildSettingsSelect(guildId) {
    const settings = getSettings(guildId);
    
    const select = new StringSelectMenuBuilder()
        .setCustomId(`select_source_${guildId}`)
        .setPlaceholder('Выберите источник поиска...')
        .addOptions([
            {
                label: 'SoundCloud',
                description: 'Поиск треков на платформе SoundCloud',
                value: 'sc',
                emoji: '🟠',
                default: settings.searchSource === 'sc'
            },
            {
                label: 'YouTube',
                description: 'Поиск треков на платформе YouTube',
                value: 'yt',
                emoji: '🔴',
                default: settings.searchSource === 'yt'
            }
        ]);
        
    return new ActionRowBuilder().addComponents(select);
}

// Unified play helper to handle SoundCloud and YouTube searches
async function playTrack(guildId, voiceChannel, query, member, textChan) {
    const settings = getSettings(guildId);
    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    
    if (isUrl) {
        return distube.play(voiceChannel, query, {
            member: member,
            textChannel: textChan
        });
    }
    
    if (settings.searchSource === 'sc') {
        const scPlugin = distube.plugins.find(p => p.constructor.name === 'SoundCloudPlugin');
        if (scPlugin) {
            if (textChan) textChan.send(`🔍 **[Алиса]** Ищу \`${query}\` на SoundCloud...`);
            try {
                const results = await scPlugin.search(query, 'track', 1);
                if (results && results.length > 0) {
                    return distube.play(voiceChannel, results[0], {
                        member: member,
                        textChannel: textChan
                    });
                } else {
                    if (textChan) textChan.send(`❌ **[Алиса]** Ничего не найдено на SoundCloud по запросу \`${query}\`.`);
                    return;
                }
            } catch (e) {
                console.error(`[NodeBot] SoundCloud search error:`, e);
            }
        }
    }
    
    if (textChan) textChan.send(`🔍 **[Алиса]** Ищу \`${query}\` на YouTube...`);
    return distube.play(voiceChannel, query, {
        member: member,
        textChannel: textChan
    });
}

// Register slash commands globally
async function registerSlashCommands(token) {
    try {
        const clientId = Buffer.from(token.split('.')[0], 'base64').toString('utf-8');
        console.log(`[NodeBot] Извлечен Client ID: ${clientId}`);
        
        const commandsList = [
            new SlashCommandBuilder()
                .setName('play')
                .setDescription('Воспроизвести трек (по ссылке или названию)')
                .addStringOption(option =>
                    option.setName('query')
                        .setDescription('Название песни или ссылка (YouTube/SoundCloud)')
                        .setRequired(true)),
            new SlashCommandBuilder()
                .setName('skip')
                .setDescription('Пропустить текущую песню'),
            new SlashCommandBuilder()
                .setName('stop')
                .setDescription('Остановить музыку и очистить очередь'),
            new SlashCommandBuilder()
                .setName('pause')
                .setDescription('Приостановить воспроизведение'),
            new SlashCommandBuilder()
                .setName('resume')
                .setDescription('Возобновить воспроизведение'),
            new SlashCommandBuilder()
                .setName('join')
                .setDescription('Подключить Алису к вашему голосовому каналу'),
            new SlashCommandBuilder()
                .setName('leave')
                .setDescription('Отключить Алису от голосового канала'),
            new SlashCommandBuilder()
                .setName('settings')
                .setDescription('Открыть интерактивное меню настроек Алисы')
        ].map(command => command.toJSON());

        const rest = new REST({ version: '10' }).setToken(token);
        console.log('[NodeBot] Начало обновления глобальных (/)...');
        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commandsList },
        );
        console.log('[NodeBot] Успешно перезаписаны глобальные (/) команды.');
    } catch (e) {
        console.error('[NodeBot] Ошибка регистрации слэш-команд:', e);
    }
}

let textChannel = null;
const activeStreams = new Set();

client.on(Events.ClientReady, async () => {
    console.log(`[NodeBot] Запущен как ${client.user.tag}!`);
    await registerSlashCommands(process.env.DISCORD_TOKEN);
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
                    const settings = getSettings(channel.guild.id);
                    
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        console.log(`[Python] ${line}`);
                        
                        if (line.startsWith('TEXT:')) {
                            const text = line.substring(5).trim();
                            if (text && debugChannel && settings.debugLogs) await debugChannel.send(`🗣️ \`${userName}\` сказал: ${text}`);
                        } else if (line.startsWith('MUSIC:')) {
                            const query = line.substring(6).trim();
                            if (query) {
                                if (debugChannel && settings.debugLogs) await debugChannel.send(`🎵 Распознана команда на музыку: ${query}`);
                                const guild = client.guilds.cache.get(channel.guild.id);
                                const member = guild.members.cache.get(userId);
                                if (member && member.voice.channel) {
                                    playTrack(channel.guild.id, member.voice.channel, query, member, textChannel);
                                }
                            }
                        } else if (line.startsWith('STOP:')) {
                            if (debugChannel && settings.debugLogs) await debugChannel.send(`🛑 Получена голосовая команда на выключение музыки`);
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
                            if (debugChannel && settings.debugLogs) await debugChannel.send(`⏸️ Получена голосовая команда на паузу`);
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
                            if (debugChannel && settings.debugLogs) await debugChannel.send(`▶️ Получена голосовая команда на возобновление`);
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
                            if (debugChannel && settings.debugLogs) await debugChannel.send(`⏭️ Получена голосовая команда на пропуск трека`);
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
                            if (debugChannel && settings.debugLogs) await debugChannel.send(`📻 Получена голосовая команда на автоплей`);
                            try {
                                const queue = distube.getQueue(channel.guild.id);
                                if (queue) {
                                    // Toggle Autoplay both in settings and queue
                                    settings.autoplay = !settings.autoplay;
                                    queue.autoplay = settings.autoplay;
                                    if (textChannel) await textChannel.send(`📻 **[Алиса]** Автовоспроизведение рекомендаций теперь **${settings.autoplay ? 'ВКЛЮЧЕНО' : 'ВЫКЛЮЧЕНО'}**.`);
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
            
            await playTrack(message.guild.id, voiceChannel, query, message.member, message.channel);
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

// Slash command and interactive settings menu handler
client.on(Events.InteractionCreate, async interaction => {
    const { guildId, guild, member, channel } = interaction;
    
    if (interaction.isChatInputCommand()) {
        if (!guild) return interaction.reply({ content: 'Эта команда может быть использована только на сервере.', ephemeral: true });
        const settings = getSettings(guildId);
        const { commandName } = interaction;
        
        if (commandName === 'play') {
            const query = interaction.options.getString('query');
            const voiceChannel = member?.voice?.channel;
            if (!voiceChannel) {
                return interaction.reply({ content: '❌ Вы должны находиться в голосовом канале!', ephemeral: true });
            }
            
            await interaction.deferReply();
            try {
                // Подключаемся к голосовому каналу и настраиваем слушатель речи
                await joinChannel(voiceChannel, channel);
                
                await playTrack(guildId, voiceChannel, query, member, channel);
                await interaction.editReply({ content: `🔍 Начат поиск и добавление трека: \`${query}\`` });
            } catch (e) {
                console.error(e);
                await interaction.editReply({ content: `❌ Ошибка: ${e.message}` });
            }
        }
        
        else if (commandName === 'skip') {
            const queue = distube.getQueue(guildId);
            if (!queue) return interaction.reply({ content: '❌ Очередь пуста.', ephemeral: true });
            try {
                if (queue.songs.length === 1) queue.stop();
                else queue.skip();
                await interaction.reply({ content: '⏭️ Текущий трек пропущен!' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'stop') {
            const queue = distube.getQueue(guildId);
            if (!queue) return interaction.reply({ content: '❌ Очередь пуста.', ephemeral: true });
            try {
                queue.stop();
                await interaction.reply({ content: '🛑 Музыка остановлена, очередь очищена!' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'pause') {
            const queue = distube.getQueue(guildId);
            if (!queue) return interaction.reply({ content: '❌ Очередь пуста.', ephemeral: true });
            if (queue.paused) return interaction.reply({ content: '⏸️ Музыка уже на паузе.', ephemeral: true });
            try {
                queue.pause();
                await interaction.reply({ content: '⏸️ Воспроизведение приостановлено.' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'resume') {
            const queue = distube.getQueue(guildId);
            if (!queue) return interaction.reply({ content: '❌ Очередь пуста.', ephemeral: true });
            if (!queue.paused) return interaction.reply({ content: '▶️ Музыка уже играет.', ephemeral: true });
            try {
                queue.resume();
                await interaction.reply({ content: '▶️ Воспроизведение возобновлено.' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'join') {
            const voiceChannel = member?.voice?.channel;
            if (!voiceChannel) {
                return interaction.reply({ content: '❌ Вы должны находиться в голосовом канале!', ephemeral: true });
            }
            try {
                await joinChannel(voiceChannel, channel);
                await interaction.reply({ content: '✅ Подключилась к голосовому каналу и начала слушать голоса!' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'leave') {
            try {
                distube.voices.leave(guild);
                await interaction.reply({ content: '🔇 Отключилась от голосового канала.' });
            } catch (e) {
                await interaction.reply({ content: `❌ Ошибка: ${e.message}`, ephemeral: true });
            }
        }
        
        else if (commandName === 'settings') {
            const embed = buildSettingsEmbed(guildId);
            const row1 = buildSettingsButtons(guildId);
            const row2 = buildSettingsSelect(guildId);
            
            await interaction.reply({
                embeds: [embed],
                components: [row2, row1],
                ephemeral: true
            });
        }
    }
    
    else if (interaction.isButton()) {
        if (!guildId) return;
        const settings = getSettings(guildId);
        const { customId } = interaction;
        
        if (customId === `toggle_autoplay_${guildId}`) {
            settings.autoplay = !settings.autoplay;
            
            // Также обновляем autoplay в текущей очереди DisTube
            const queue = distube.getQueue(guildId);
            if (queue) {
                queue.autoplay = settings.autoplay;
            }
            
            const embed = buildSettingsEmbed(guildId);
            const row1 = buildSettingsButtons(guildId);
            const row2 = buildSettingsSelect(guildId);
            
            await interaction.update({
                embeds: [embed],
                components: [row2, row1]
            });
        }
        
        else if (customId === `toggle_debug_${guildId}`) {
            settings.debugLogs = !settings.debugLogs;
            
            const embed = buildSettingsEmbed(guildId);
            const row1 = buildSettingsButtons(guildId);
            const row2 = buildSettingsSelect(guildId);
            
            await interaction.update({
                embeds: [embed],
                components: [row2, row1]
            });
        }
    }
    
    else if (interaction.isStringSelectMenu()) {
        if (!guildId) return;
        const settings = getSettings(guildId);
        const { customId, values } = interaction;
        
        if (customId === `select_source_${guildId}`) {
            settings.searchSource = values[0];
            
            const embed = buildSettingsEmbed(guildId);
            const row1 = buildSettingsButtons(guildId);
            const row2 = buildSettingsSelect(guildId);
            
            await interaction.update({
                embeds: [embed],
                components: [row2, row1]
            });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
