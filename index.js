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

const distube = new DisTube(client, {
    plugins: [new SoundCloudPlugin()],
    emitNewSongOnly: true,
    leaveOnEmpty: true,
    leaveOnFinish: false,
    leaveOnStop: false
});

const player = createAudioPlayer();
let textChannel = null;
let currentConnection = null;
let currentPlayingMp3 = null;
const activeStreams = new Set();

client.on(Events.ClientReady, () => {
    console.log(`[NodeBot] Запущен как ${client.user.tag}!`);
});

// DisTube events
distube.on('playSong', (queue, song) => {
    if (textChannel) {
        textChannel.send(`🎵 **Включаю:** \`${song.name}\` - \`${song.formattedDuration}\`\nСсылка: ${song.url}`);
    }
});
distube.on('addSong', (queue, song) => {
    if (textChannel) {
        textChannel.send(`✅ **Добавлено в очередь:** \`${song.name}\``);
    }
});
distube.on('error', (channel, error) => {
    console.error('[DisTube Error]', error);
    if (channel) channel.send(`❌ Возникла ошибка: ${error.message.slice(0, 2000)}`);
});

function findTextChannel(guild) {
    const ch = guild.channels.cache.find(ch => 
        ch.isTextBased() && 
        ch.permissionsFor(guild.members.me).has('SendMessages')
    );
    return ch;
}

function joinChannel(channel, textChan) {
    console.log(`[NodeBot] Попытка подключения к "${channel.name}"...`);
    textChannel = textChan;
    
    if (currentConnection) {
        try { currentConnection.destroy(); } catch (e) {}
    }
    
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });
    
    currentConnection = connection;
    connection.subscribe(player);
    
    connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[NodeBot] Подключился к каналу: ${channel.name}`);
        if (textChannel) {
            textChannel.send(`✅ **[Алиса]** Я здесь. Готова включать музыку или общаться (триггер: \`Алиса\`).\nМожно сказать "Алиса, включи музыку Rammstein".`);
        }
        
        const welcomeMp3 = path.join(__dirname, 'welcome.mp3');
        const welcomeText = 'Привет! Я Алиса. Назовите меня и скажите, что включить.';
        
        const ttsProcess = spawn('/root/botparsecdota2/venv_voice/bin/python', [
            path.join(__dirname, 'tts_helper.py'),
            welcomeText,
            welcomeMp3
        ]);
        
        ttsProcess.on('close', (code) => {
            if (code === 0 && fs.existsSync(welcomeMp3)) {
                currentPlayingMp3 = welcomeMp3;
                const resource = createAudioResource(welcomeMp3);
                player.play(resource);
            }
        });
    });
    
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
        } catch (error) {
            try { connection.destroy(); } catch (e) {}
            if (currentConnection === connection) currentConnection = null;
        }
    });
    
    connection.receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return;
        
        // Don't record if DisTube is currently playing (to avoid listening to its own output or just ignoring commands while music is loud)
        // Actually, users might want to say "Алиса, стоп". We will listen, but skip if volume issues.
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
                
                const pythonProcess = spawn('/root/botparsecdota2/venv_voice/bin/python', [
                    path.join(__dirname, 'process_audio.py'),
                    pcmWavPath
                ]);
            
                pythonProcess.stdout.on('data', (data) => {
                    const lines = data.toString().split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        
                        if (line.startsWith('TEXT:')) {
                            const text = line.substring(5).trim();
                            if (text && textChannel) textChannel.send(`🗣️ \`${userName}\`: ${text}`);
                        } else if (line.startsWith('REPLY:')) {
                            const reply = line.substring(6).trim();
                            if (reply && textChannel) textChannel.send(`💬 **Алиса**: ${reply}`);
                        } else if (line.startsWith('MP3:')) {
                            // If distube is playing, maybe pause it or let it play alongside?
                            // We will stop default player if distube is playing.
                            // Actually distube handles its own voice connection. If we play a resource directly, we might override it or it overrides us.
                            const mp3Path = line.substring(4).trim();
                            const guild = client.guilds.cache.get(channel.guild.id);
                            const queue = distube.getQueue(guild);
                            
                            if (queue && queue.playing) {
                                // Just delete the MP3 if music is playing, or pause music, play, resume.
                                // For simplicity, we just send text reply if music is playing.
                                try { fs.unlinkSync(mp3Path); } catch(e){}
                            } else {
                                currentPlayingMp3 = mp3Path;
                                const resource = createAudioResource(mp3Path);
                                player.play(resource);
                            }
                        } else if (line.startsWith('MUSIC:')) {
                            const query = line.substring(6).trim();
                            if (query) {
                                console.log(`[NodeBot] Голосовой запрос музыки: ${query}`);
                                const guild = client.guilds.cache.get(channel.guild.id);
                                const member = guild.members.cache.get(userId);
                                if (member && member.voice.channel) {
                                    // Search soundcloud and play
                                    // Make sure we stop AI TTS player first if playing
                                    player.stop();
                                    distube.play(member.voice.channel, query, {
                                        member: member,
                                        textChannel: textChannel
                                    });
                                }
                            }
                        }
                    }
                });
                
                pythonProcess.on('close', () => {
                    try { fs.unlinkSync(pcmWavPath); } catch(e){}
                });
            });
        });
        
        writeStream.on('error', () => {
            activeStreams.delete(userId);
            try { fs.unlinkSync(pcmWavPath); } catch(e){}
        });
    });
    
    return connection;
}

client.on(Events.MessageCreate, async message => {
    if (!message.guild || message.author.bot) return;
    
    const args = message.content.trim().split(/ +/g);
    const command = args.shift().toLowerCase();
    
    if (command === '!play') {
        const query = args.join(' ');
        if (!query) return message.reply('Укажите что искать (например, !play sc:rammstein)');
        
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) return message.reply('Вы должны быть в голосовом канале!');
        
        // Stop our tts player if it's playing
        player.stop();
        
        try {
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
    } else if (command === '!skip') {
        const queue = distube.getQueue(message);
        if (!queue) return message.reply('Очередь пуста.');
        try {
            if (queue.songs.length === 1) queue.stop();
            else queue.skip();
            message.reply('Пропущено.');
        } catch (e) {
            message.reply(`${e}`);
        }
    } else if (command === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinChannel(voiceChannel, message.channel);
        } else {
            message.reply('Вы должны находиться в голосовом канале!');
        }
    } else if (command === '!leave') {
        distube.voices.leave(message.guild);
        if (currentConnection) {
            try { currentConnection.destroy(); } catch (e) {}
            currentConnection = null;
        }
        message.reply('Отключилась.');
    }
});

player.on(AudioPlayerStatus.Idle, () => {
    if (currentPlayingMp3) {
        try { fs.unlinkSync(currentPlayingMp3); } catch (e) {}
        currentPlayingMp3 = null;
    }
});

client.login(process.env.DISCORD_TOKEN);
