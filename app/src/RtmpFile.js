'use strict';

/** @typedef {import('fluent-ffmpeg').FfmpegCommand} FfmpegCommand */
/** @typedef {import('fs').ReadStream} ReadStream */

/** @typedef {import('./RtmpStreaming')} RtmpStreaming */


const ffmpeg = require('fluent-ffmpeg');

const config = require('./config');
const Logger = require('./Logger');

const log = new Logger('RtmpFile');
const ffmpegPath = config.media?.rtmp?.ffmpegPath || '/usr/bin/ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);

/** Worker that streams local video file to RTMP server via FFmpeg (input: fs.ReadStream → FFmpeg → RTMP) */
class RtmpFile {
    
    /**
     * @param {string} socket_id - Socket ID for sending callbacks to client
     * @param {RtmpStreaming} rtmpStreaming - RtmpStreaming instance (provides send() method and rtmpFileStreamer property)
     */
    constructor(socket_id, rtmpStreaming) {
        this.socketId = socket_id;
        this.rtmpStreaming = rtmpStreaming;
        this.rtmpUrl = '';

        /** @type {FfmpegCommand|null} FFmpeg process handle for streaming */
        this.ffmpegProcess = null;
        
        this.stopping = false;
    }

    /**
     * Start FFmpeg transcoding from file stream to RTMP
     * @param {ReadStream} inputStream - File read stream from fs.createReadStream()
     * @param {string} rtmpUrl - RTMP destination URL (e.g., rtmp://localhost:1935/live/stream)
     * @returns {Promise<boolean>} true if started, false if already running or error
     */
    async start(inputStream, rtmpUrl) {
        if (this.ffmpegProcess) {
            log.debug('Streaming is already in progress');
            return false;
        }

        this.rtmpUrl = rtmpUrl;

        try {
            this.ffmpegProcess = ffmpeg(inputStream)
                .inputOptions(['-re']) // Read input at native frame rate
                .outputOptions([
                    '-c:v libx264', // Encode video to H.264
                    '-preset veryfast', // Set preset to very fast
                    '-maxrate 3000k', // Max bitrate for the video stream
                    '-bufsize 6000k', // Buffer size
                    '-g 50', // GOP size
                    '-c:a aac', // Encode audio to AAC
                    '-b:a 128k', // Bitrate for the audio stream
                    '-f flv', // Output format
                ])
                .output(rtmpUrl)
                .on('start', (commandLine) => log.debug('ffmpeg process starting with command:', commandLine))
                .on('progress', (progress) => {
                    /* log.debug('Processing', progress); */
                })
                .on('error', (err, stdout, stderr) => {
                    this.ffmpegProcess = null;
                    if (!err.message.includes('Exiting normally')) {
                        this.handleError(err.message, stdout, stderr);
                    }
                })
                .on('end', () => {
                    log.debug('FFmpeg processing finished');
                    this.ffmpegProcess = null;
                    this.handleEnd();
                })
                .run();

            log.debug('RtmpFile started', rtmpUrl);
            return true;
        } catch (error) {
            log.error('Error starting RtmpFile', error.message);
            return false;
        }
    }

    async stop() {
        if (this.stopping) return true;
        this.stopping = true;

        if (this.ffmpegProcess) {
            try {
                this.ffmpegProcess.kill('SIGTERM');
                this.ffmpegProcess = null;
                log.debug('RtmpFile stopped');
                return true;
            } catch (error) {
                log.error('Error stopping RtmpFile', error.message);
                return false;
            }
        } else {
            log.debug('No RtmpFile process to stop');
            return true;
        }
    }

    handleEnd() {
        if (!this.rtmpStreaming) return;
        this.rtmpStreaming.send(this.socketId, 'endRTMPfromFile', { rtmpUrl: this.rtmpUrl });
        this.rtmpStreaming.rtmpFileStreamer = null;
    }

    handleError(message, stdout, stderr) {
        if (!this.rtmpStreaming) return;
        this.rtmpStreaming.send(this.socketId, 'errorRTMPfromFile', { message });
        this.rtmpStreaming.rtmpFileStreamer = null;
        log.error('Error: ' + message, { stdout, stderr });
    }
}

module.exports = RtmpFile;
