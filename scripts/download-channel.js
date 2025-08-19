
"use strict";
const fs = require("fs");
const path = require("path");
const { initAuth } = require("../modules/auth");
const {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
  uploadMessageToChannel,
  forwardMessageToChannel,
} = require("../modules/messages");
const {
  getMediaType,
  getMediaPath,
  checkFileExist,
  appendToJSONArrayFile,
  wait,
} = require("../utils/helper");
const {
  updateLastSelection,
  getLastSelection,
} = require("../utils/file-helper");
const logger = require("../utils/logger");
const { getDialogName, getAllDialogs } = require("../modules/dialoges");
const {
  downloadOptionInput,
  selectInput,
  booleanInput,
} = require("../utils/input-helper");

// SAFETY IMPROVEMENTS: Optimized for 30 Mbps speed with upload functionality
const MAX_PARALLEL_PROCESS = 5; // Process 5 messages in parallel
const MESSAGE_LIMIT = 100; // Smaller batches for better control
const RATE_LIMIT_DELAY = 1500; // Reduced to 1.5 seconds for faster processing
const DOWNLOAD_DELAY = 200; // Reduced to 200ms for 30 Mbps speed
const UPLOAD_DELAY = 300; // Reduced to 300ms for faster uploads
const MAX_RETRIES = 3;
const BACKOFF_BASE = 1000;

/**
 * Enhanced Telegram Channel Downloader with Upload Functionality
 */
class DownloadChannel {
  constructor() {
    this.outputFolder = null;
    this.uploadMode = false;
    this.targetChannelId = null;
    this.downloadableFiles = null;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.totalDownloaded = 0;
    this.totalUploaded = 0;
    this.totalMessages = 0;
    this.totalProcessedMessages = 0;
    this.skippedFiles = 0;

    const exportPath = path.resolve(process.cwd(), "./export");
    if (!fs.existsSync(exportPath)) {
      fs.mkdirSync(exportPath);
    }
  }

  static description() {
    return "Download all messages from a channel with optional upload to another channel";
  }

  /**
   * Rate limiting with exponential backoff
   */
  async checkRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (this.requestCount > 15 && timeSinceLastRequest < 60000) {
      logger.info("Rate limit protection: Waiting 60 seconds...");
      await this.wait(60000);
      this.requestCount = 0;
    }
    
    this.lastRequestTime = now;
    this.requestCount++;
  }

  /**
   * Enhanced wait function with random delays
   */
  async wait(ms) {
    const randomDelay = Math.random() * 500;
    const totalDelay = ms + randomDelay;
    await new Promise(resolve => setTimeout(resolve, totalDelay));
  }

  /**
   * Retry mechanism with exponential backoff
   */
  async retryWithBackoff(fn, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.checkRateLimit();
        return await fn();
      } catch (error) {
        logger.warn(`Attempt ${i + 1} failed: ${error.message}`);
        
        if (i === retries - 1) throw error;
        
        const backoffDelay = BACKOFF_BASE * Math.pow(2, i);
        await this.wait(backoffDelay);
      }
    }
  }

  /**
   * Check if message has any content (text, media, sticker, etc.)
   */
  hasContent(message) {
    return Boolean(
      message.message || 
      message.media || 
      message.sticker ||
      message.document ||
      message.photo ||
      message.video ||
      message.audio ||
      message.voice ||
      message.poll ||
      message.geo ||
      message.contact ||
      message.venue ||
      message.webpage
    );
  }

  /**
   * Determines if a message should be processed
   */
  shouldProcess(message) {
    if (!this.hasContent(message)) return false;
    
    // Always process text messages
    if (message.message && !message.media) return true;
    
    // For media messages, check if we want to download this type
    if (message.media) {
      const mediaType = getMediaType(message);
      const mediaPath = getMediaPath(message, this.outputFolder);
      const extension = path.extname(mediaPath).toLowerCase().replace(".", "");
      
      return this.downloadableFiles?.[mediaType] ||
             this.downloadableFiles?.[extension] ||
             this.downloadableFiles?.all;
    }
    
    return true;
  }

  /**
   * Download media from message
   */
  async downloadMessage(client, message) {
    try {
      if (!message.media) return null;
      
      const mediaPath = getMediaPath(message, this.outputFolder);
      const fileExists = checkFileExist(message, this.outputFolder);
      
      if (fileExists) {
        logger.info(`⏭️  File already exists: ${path.basename(mediaPath)}`);
        return mediaPath;
      }

      const result = await downloadMessageMedia(client, message, mediaPath);
      if (result) {
        this.totalDownloaded++;
        logger.info(`✅ Downloaded: ${path.basename(mediaPath)}`);
        return mediaPath;
      }
    } catch (error) {
      logger.error(`❌ Download failed for message ${message.id}: ${error.message}`);
    }
    return null;
  }

  /**
   * Upload message to target channel
   */
  async uploadMessage(client, message, mediaPath = null) {
    try {
      if (!this.uploadMode || !this.targetChannelId) return false;

      const result = await uploadMessageToChannel(
        client,
        this.targetChannelId,
        message,
        mediaPath
      );

      if (result) {
        this.totalUploaded++;
        logger.info(`📤 Uploaded message ${message.id} to target channel`);
        
        // Clean up local file after successful upload
        if (mediaPath && fs.existsSync(mediaPath)) {
          try {
            fs.unlinkSync(mediaPath);
            logger.info(`🗑️  Cleaned up local file: ${path.basename(mediaPath)}`);
          } catch (cleanupError) {
            logger.warn(`⚠️  Could not delete local file: ${cleanupError.message}`);
          }
        }
        return true;
      }
    } catch (error) {
      logger.error(`❌ Upload failed for message ${message.id}: ${error.message}`);
    }
    return false;
  }

  /**
   * Process a single message (download and optionally upload)
   * Handles all message types: text, media, stickers, documents, etc.
   */
  async processMessage(client, message, index, total) {
    try {
      logger.info(`🔄 Processing message ${message.id} (${index + 1}/${total})`);
      
      let mediaPath = null;
      let hasContent = false;
      
      // Handle text messages
      if (message.message && message.message.trim()) {
        hasContent = true;
        logger.info(`📝 Text message: "${message.message.substring(0, 50)}${message.message.length > 50 ? '...' : ''}"`);
      }
      
      // Handle media messages (photos, videos, documents, audio, etc.)
      if (message.media) {
        hasContent = true;
        mediaPath = await this.downloadMessage(client, message);
        await this.wait(DOWNLOAD_DELAY);
      }
      
      // Handle stickers
      if (message.sticker) {
        hasContent = true;
        mediaPath = await this.downloadMessage(client, message);
        await this.wait(DOWNLOAD_DELAY);
      }
      
      // Always upload if upload mode is enabled and message has content
      if (this.uploadMode && hasContent) {
        const uploadSuccess = await this.uploadMessage(client, message, mediaPath);
        if (uploadSuccess) {
          logger.info(`✅ Message ${message.id} uploaded with preserved caption/text`);
        }
        await this.wait(UPLOAD_DELAY);
      } else if (!this.uploadMode && hasContent) {
        // If not uploading, just log that we processed the content
        if (message.message && !message.media) {
          logger.info(`💾 Text message saved locally`);
        }
      }

      this.totalProcessedMessages++;
      
    } catch (error) {
      logger.error(`❌ Error processing message ${message.id}: ${error.message}`);
    }
  }

  /**
   * Record all messages to JSON file
   */
  recordMessages(messages) {
    const filePath = path.join(this.outputFolder, "all_messages.json");
    if (!fs.existsSync(this.outputFolder)) {
      fs.mkdirSync(this.outputFolder, { recursive: true });
    }

    const data = messages.map((msg) => ({
      id: msg.id,
      message: msg.message || "",
      date: msg.date,
      out: msg.out,
      hasMedia: !!msg.media,
      sender: msg.fromId?.userId || msg.peerId?.userId,
      mediaType: this.hasContent(msg) ? getMediaType(msg) : undefined,
      mediaPath: this.hasContent(msg) && msg.media
        ? getMediaPath(msg, this.outputFolder)
        : undefined,
      mediaName: this.hasContent(msg) && msg.media
        ? path.basename(getMediaPath(msg, this.outputFolder))
        : undefined,
    }));
    
    appendToJSONArrayFile(filePath, data);
  }

  /**
   * Show detailed progress information
   */
  showProgress(currentBatch) {
    const progressPercentage = this.totalMessages > 0 
      ? Math.round((this.totalProcessedMessages / this.totalMessages) * 100) 
      : 0;
    
    logger.info("=".repeat(60));
    logger.info("📊 PROCESSING PROGRESS REPORT");
    logger.info("=".repeat(60));
    logger.info(`📥 Total Downloaded: ${this.totalDownloaded} files`);
    if (this.uploadMode) {
      logger.info(`📤 Total Uploaded: ${this.totalUploaded} messages`);
    }
    logger.info(`📈 Progress: ${progressPercentage}% (${this.totalProcessedMessages}/${this.totalMessages})`);
    logger.info(`📦 Current batch: ${currentBatch} messages processed`);
    logger.info("=".repeat(60));
  }

  /**
   * Main download and upload function
   */
  async downloadChannel(client, channelId, offsetMsgId = 0) {
    try {
      this.outputFolder = path.join(
        process.cwd(),
        "export",
        channelId.toString()
      );

      // Get messages with rate limiting
      const messages = await this.retryWithBackoff(async () => {
        return await getMessages(client, channelId, MESSAGE_LIMIT, offsetMsgId);
      });

      if (!messages.length) {
        logger.info("🎉 Processing completed! No more messages to process.");
        this.showProgress(0);
        return;
      }

      // Get detailed message information
      const ids = messages.map((m) => m.id);
      const details = await this.retryWithBackoff(async () => {
        return await getMessageDetail(client, channelId, ids);
      });

      // Filter messages that should be processed
      const messagesToProcess = details.filter(msg => this.shouldProcess(msg));
      
      logger.info(`📋 Found ${messagesToProcess.length} messages to process out of ${details.length} total`);

      // Process messages in parallel batches of 5
      const processPromises = [];
      for (let i = 0; i < messagesToProcess.length; i += MAX_PARALLEL_PROCESS) {
        const batch = messagesToProcess.slice(i, i + MAX_PARALLEL_PROCESS);
        
        const batchPromises = batch.map((msg, index) => 
          this.processMessage(client, msg, i + index, messagesToProcess.length)
        );
        
        processPromises.push(Promise.all(batchPromises));
      }

      // Execute all batches with delays
      for (let i = 0; i < processPromises.length; i++) {
        logger.info(`🔄 Processing batch ${i + 1}/${processPromises.length}`);
        await processPromises[i];
        
        if (i < processPromises.length - 1) {
          await this.wait(RATE_LIMIT_DELAY);
        }
      }

      // Record all messages
      this.recordMessages(details);
      
      // Update selection for next batch
      updateLastSelection({
        messageOffsetId: messages[messages.length - 1].id,
      });

      // Show progress
      this.showProgress(messagesToProcess.length);

      // Continue with next batch
      await this.wait(RATE_LIMIT_DELAY);
      await this.downloadChannel(
        client,
        channelId,
        messages[messages.length - 1].id
      );
      
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
      
      if (err.message && err.message.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(err.message.match(/\d+/)?.[0] || "300") * 1000;
        logger.info(`⚠️  Rate limited! Waiting ${waitTime / 1000} seconds...`);
        await this.wait(waitTime);
        return await this.downloadChannel(client, channelId, offsetMsgId);
      }
      
      throw err;
    }
  }

  /**
   * Configure download and upload options
   */
  async configureDownload(options, client) {
    let channelId = options.channelId;
    let downloadableFiles = options.downloadableFiles;
    
    // Select source channel
    if (!channelId) {
      logger.info("Please select a channel to download from");
      const allChannels = await getAllDialogs(client);
      const channelOptions = allChannels.map((d) => ({
        name: d.name,
        value: d.id,
      }));

      channelId = await selectInput(
        "Please select source channel",
        channelOptions
      );
    }

    // Ask for upload mode
    this.uploadMode = await booleanInput(
      "Do you want to upload messages to another channel? (No = save locally only)"
    );

    if (this.uploadMode) {
      logger.info("Please select target channel for upload");
      const allChannels = await getAllDialogs(client);
      const targetOptions = allChannels
        .filter(d => d.id !== channelId) // Exclude source channel
        .map((d) => ({
          name: d.name,
          value: d.id,
        }));

      this.targetChannelId = await selectInput(
        "Please select target channel for upload",
        targetOptions
      );
      
      logger.info(`📤 Upload mode enabled. Target channel: ${this.targetChannelId}`);
    } else {
      logger.info("💾 Local storage mode enabled. Files will be saved locally only.");
    }
    
    // Configure file types (allow all by default for comprehensive download)
    if (!downloadableFiles) {
      downloadableFiles = {
        webpage: true,
        poll: true,
        geo: true,
        contact: true,
        venue: true,
        sticker: true,
        image: true,
        video: true,
        audio: true,
        voice: true,
        document: true,
        pdf: true,
        zip: true,
        all: true
      };
    }

    this.downloadableFiles = downloadableFiles;

    const lastSelection = getLastSelection();
    let messageOffsetId = lastSelection.messageOffsetId || 0;

    if (Number(lastSelection.channelId) !== Number(channelId)) {
      messageOffsetId = 0;
    }
    
    updateLastSelection({ messageOffsetId, channelId });
    return { channelId, messageOffsetId };
  }

  /**
   * Main handler function
   */
  async handle(options = {}) {
    let client;
    
    try {
      await this.wait(1000);
      
      client = await initAuth();
      const { channelId, messageOffsetId } = await this.configureDownload(
        options,
        client
      );

      const dialogName = await getDialogName(client, channelId);
      logger.info(`🚀 Starting enhanced download from channel: ${dialogName}`);
      logger.info(`⚙️  Settings: Parallel processing: ${MAX_PARALLEL_PROCESS}, Upload mode: ${this.uploadMode ? 'ON' : 'OFF'}`);
      
      if (this.uploadMode) {
        const targetName = await getDialogName(client, this.targetChannelId);
        logger.info(`📤 Target channel: ${targetName}`);
      }
      
      await this.downloadChannel(client, channelId, messageOffsetId);
      
    } catch (err) {
      logger.error("An error occurred:");
      console.error(err);
      await this.wait(30000);
      
    } finally {
      if (client) {
        try {
          await client.disconnect();
        } catch (disconnectErr) {
          logger.warn("Error disconnecting client:", disconnectErr.message);
        }
      }
      process.exit(0);
    }
  }
}

module.exports = DownloadChannel;
