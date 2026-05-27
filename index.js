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

const distube = new DisTube(client, {
    plugins: [new SoundCloudPlugin()],
    emitNewSongOnly: true
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

async function joinChannel(channel, textChan) {
    console.log(`[NodeBot] Попытка подключения к "${channel.name}" через DisTube...`);
    textChannel = textChan;
    
    // Используем DisTube для подключения, чтобы он управлял соединением
    const voice = await distube.voices.join(channel);
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
                ]);
            
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
        
        writeStream.on('error', () => {
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
    
    if (command === '!play') {
        const query = args.join(' ');
        if (!query) return message.reply('Укажите что искать (например, !play sc:rammstein)');
        
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) return message.reply('Вы должны быть в голосовом канале!');
        
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
        message.reply('Отключилась.');
    }
});

client.login(process.env.DISCORD_TOKEN);
