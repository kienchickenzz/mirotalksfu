'use strict';

const { PassThrough } = require('stream');

const ffmpeg = require('fluent-ffmpeg');

const config = require('./config');
const Logger = require('./Logger');

const log = new Logger('RtmpStreamer');

const ffmpegPath = config.media?.rtmp?.ffmpegPath || '/usr/bin/ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * @typedef {import('stream').PassThrough} PassThroughStream
 * @typedef {import('fluent-ffmpeg').FfmpegCommand} FfmpegCommand
 */

/** Worker that streams browser camera/screen to RTMP server via FFmpeg (input: WebM chunks via HTTP POST → PassThrough → FFmpeg → RTMP) */
class RtmpStreamer {

    /**
     * @param {string} rtmpUrl - RTMP destination URL (e.g., rtmp://localhost:1935/live/streamKey)
     * @param {string} rtmpKey - Unique stream key for identifying this stream
     */
    constructor(rtmpUrl, rtmpKey) {
        this.rtmpUrl = rtmpUrl;
        this.rtmpKey = rtmpKey;

        /** @type {PassThroughStream|null} */
        this.stream = new PassThrough();

        /** @type {FfmpegCommand|null} */
        this.ffmpegStream = null;

        this.log = log;
        this.ending = false;
        this.lastActivity = Date.now();

        this.initFFmpeg();

        this.run = true;
    }

    /**
     * Initialize FFmpeg pipeline: PassThrough → FFmpeg (WebM→FLV transcode) → RTMP output
     * @returns {void}
     */
    initFFmpeg() {
        this.ffmpegStream = ffmpeg()
            .input(this.stream)
            .inputFormat('webm')
            .inputOptions('-re')
            .videoCodec('libx264')
            .videoBitrate('3000k')
            .size('1280x720')
            .audioCodec('aac')
            .audioBitrate('128k')
            .outputOptions(['-f flv'])
            .output(this.rtmpUrl)
            .on('start', (commandLine) => this.log.debug('ffmpeg command', { id: this.rtmpKey, cmd: commandLine }))
            .on('progress', (progress) => {
                /* log.debug('Processing', progress); */
            })
            .on('error', (err, stdout, stderr) => {
                if (!err.message.includes('Exiting normally')) {
                    this.log.error(`Error: ${err.message}`, { stdout, stderr });
                }
                this.end();
            })
            .on('end', () => {
                this.log.debug('FFmpeg process ended', this.rtmpKey);
                this.end();
            })
            .run();
    }

    /**
     * Write video chunk data to the PassThrough stream (fed into FFmpeg)
     * @param {Buffer} data - WebM video chunk from client HTTP POST
     */
    write(data) {
        if (this.stream) this.stream.write(data);
    }

    /**
     * Check if FFmpeg stream is still running
     * @returns {boolean}
     */
    isRunning() {
        return this.run;
    }

    /**
     * Stop FFmpeg process and close PassThrough stream
     * @returns {void}
     */
    end() {
        if (this.ending) return;
        this.ending = true;

        if (this.stream) {
            this.stream.end();
            this.stream = null;
            this.log.debug('RTMP streaming stopped', this.rtmpKey);
        }
        if (this.ffmpegStream) {
            this.ffmpegStream.kill('SIGTERM');
            this.ffmpegStream = null;
            this.log.debug('FFMPEG closed successfully', this.rtmpKey);
        }
        this.run = false;
    }
}

module.exports = RtmpStreamer;
