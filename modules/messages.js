const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { circularStringify } = require("../utils/helper");

const getMessages = async (client, channelId, limit = 10, offsetId = 0) => {
  if (!client || !channelId) {
    throw new Error("Client and channelId are required");
  }

  try {
    const result = await client.getMessages(channelId, { limit, offsetId });
    return result;
  } catch (error) {
    throw new Error(`Failed to get messages: ${error.message}`);
  }
};

const getMessageDetail = async (client, channelId, messageIds) => {
  if (!client || !channelId || !messageIds) {
    throw new Error("Client, channelId, and messageIds are required");
  }

  try {
    const result = await client.getMessages(channelId, { ids: messageIds });
    return result;
  } catch (error) {
    throw new Error(`Failed to get message details: ${error.message}`);
  }
};

/**
 * Download message media with progress display - Optimized for 30 Mbps
 * @param {Object} client Telegram client
 * @param {Object} message Telegram message
 * @param {string} mediaPath Local file save path
 * @param {number} fileIndex Current file number (1-based)
 * @param {number} totalFiles Total files in this batch
 */
const downloadMessageMedia = async (client, message, mediaPath, fileIndex = 1, totalFiles = 1) => {
  try {
    if (!client || !message || !mediaPath) {
      logger.error("Client, message, and mediaPath are required");
      return false;
    }

    if (message.media) {
      // Handle special media types that don't require downloading
      if (message.media.webpage) {
        const webpage = message.media.webpage;
        if (webpage.url) {
          const urlPath = path.join(path.dirname(mediaPath), `${message.id}_webpage.txt`);
          const webpageData = {
            url: webpage.url,
            title: webpage.title || '',
            description: webpage.description || '',
            siteName: webpage.siteName || '',
            type: webpage.type || ''
          };
          fs.writeFileSync(urlPath, JSON.stringify(webpageData, null, 2));
        }

        // Download webpage photo if available
        if (webpage.photo) {
          mediaPath = path.join(
            path.dirname(mediaPath),
            `${message.id}_webpage_image.jpeg`
          );
        } else {
          return true; // No downloadable media
        }
      }

      if (message.media.poll) {
        const pollPath = path.join(path.dirname(mediaPath), `${message.id}_poll.json`);
        fs.writeFileSync(
          pollPath,
          circularStringify(message.media.poll, null, 2)
        );
        return true; // Poll saved as JSON
      }

      if (message.media.geo) {
        const geoPath = path.join(path.dirname(mediaPath), `${message.id}_location.json`);
        fs.writeFileSync(
          geoPath,
          JSON.stringify({
            latitude: message.media.geo.lat,
            longitude: message.media.geo.long,
            accuracy: message.media.geo.accuracyRadius || null
          }, null, 2)
        );
        return true; // Location saved as JSON
      }

      if (message.media.contact) {
        const contactPath = path.join(path.dirname(mediaPath), `${message.id}_contact.json`);
        fs.writeFileSync(
          contactPath,
          JSON.stringify(message.media.contact, null, 2)
        );
        return true; // Contact saved as JSON
      }

      if (message.media.venue) {
        const venuePath = path.join(path.dirname(mediaPath), `${message.id}_venue.json`);
        fs.writeFileSync(
          venuePath,
          JSON.stringify(message.media.venue, null, 2)
        );
        return true; // Venue saved as JSON
      }

      const fileName = path.basename(mediaPath);

      // Optimized download settings for 30 Mbps speed
      await client.downloadMedia(message, {
        outputFile: mediaPath,
        workers: 16, // Increased to 16 workers for maximum parallel downloads
        chunkSize: 8 * 1024 * 1024, // Increased to 8MB chunks for 30 Mbps optimization
        requestSize: 1024 * 1024, // 1MB request size for optimal throughput
        fileSize: message.media.document?.size || message.media.photo?.sizes?.[0]?.size,
        progressCallback: (downloaded, total) => {
          if (total > 0) {
            const percent = ((downloaded / total) * 100).toFixed(1);
            const speed = (downloaded / 1024 / 1024).toFixed(1); // MB downloaded
            process.stdout.write(
              `\r[${fileIndex}/${totalFiles}] ${fileName}: ${percent}% (${speed}MB)`
            );
          }
          if (downloaded === total) {
            const finalSize = (total / 1024 / 1024).toFixed(1);
            process.stdout.write(
              `\n✅ Downloaded: ${fileName} (${finalSize}MB) [${fileIndex}/${totalFiles}]\n`
            );
          }
        },
      });

      return true;
    } else if (message.sticker) {
      // Handle stickers
      const stickerPath = path.join(path.dirname(mediaPath), `${message.id}_sticker.webp`);
      await client.downloadMedia(message, {
        outputFile: stickerPath,
        workers: 16,
        chunkSize: 8 * 1024 * 1024,
        progressCallback: (downloaded, total) => {
          if (total > 0) {
            const percent = ((downloaded / total) * 100).toFixed(1);
            process.stdout.write(`\r[${fileIndex}/${totalFiles}] Sticker: ${percent}%`);
          }
          if (downloaded === total) {
            process.stdout.write(`\n✅ Downloaded: Sticker [${fileIndex}/${totalFiles}]\n`);
          }
        },
      });
      return true;
    } else {
      logger.warn(`No downloadable media found in message ${message.id}`);
      return false;
    }

  } catch (err) {
    logger.error(`Error downloading media for message ${message.id}: ${err.message}`);
    return false;
  }
};

/**
 * Upload a message with media to a target channel with preserved caption/text
 * Optimized for 30 Mbps upload speed
 * @param {Object} client Telegram client
 * @param {string} targetChannelId Target channel ID
 * @param {Object} message Original message object
 * @param {string} mediaPath Local media file path (optional)
 */
const uploadMessageToChannel = async (client, targetChannelId, message, mediaPath = null) => {
  try {
    if (!client || !targetChannelId || !message) {
      throw new Error("Client, targetChannelId, and message are required");
    }

    // Preserve original caption/text exactly as it appears
    const originalCaption = message.message || "";
    const originalEntities = message.entities || [];

    let uploadOptions = {
      message: originalCaption,
      entities: originalEntities,
      parseMode: null, // Use entities instead of parseMode for exact preservation
      silent: true,
      // Optimize upload speed for 30 Mbps
      workers: 16, // Increased workers for parallel upload
      chunkSize: 4 * 1024 * 1024, // 4MB chunks for optimal 30 Mbps speed
      progressCallback: (uploaded, total) => {
        if (total > 0) {
          const percent = ((uploaded / total) * 100).toFixed(1);
          process.stdout.write(`\r📤 Uploading: ${percent}%`);
        }
        if (uploaded === total) {
          process.stdout.write("\n");
        }
      }
    };

    // Handle different types of content
    if (message.media) {
      // Handle media messages with preserved captions
      if (mediaPath && fs.existsSync(mediaPath)) {
        // Upload with local file (for downloaded media)
        uploadOptions.file = mediaPath;
        
        // Preserve media-specific attributes
        if (message.media.photo) {
          uploadOptions.supportsStreaming = true;
        } else if (message.media.document) {
          const doc = message.media.document;
          uploadOptions.attributes = doc.attributes || [];
          uploadOptions.mimeType = doc.mimeType;
          uploadOptions.supportsStreaming = true;
        } else if (message.media.video) {
          uploadOptions.supportsStreaming = true;
          uploadOptions.videoNote = message.media.videoNote || false;
        }
        
      } else {
        // Try to forward original media with caption preservation
        try {
          const result = await client.forwardMessages(targetChannelId, {
            messages: [message.id],
            fromPeer: message.peerId,
            silent: true,
            dropAuthor: false,
            dropMediaCaptions: false // Preserve captions
          });
          return result;
        } catch (forwardError) {
          logger.warn(`Could not forward message ${message.id}, uploading as new message`);
          
          // If forwarding fails, upload original media reference
          if (message.media.photo) {
            uploadOptions.file = message.media.photo;
          } else if (message.media.document) {
            uploadOptions.file = message.media.document;
          } else if (message.media.video) {
            uploadOptions.file = message.media.video;
          } else if (message.media.audio) {
            uploadOptions.file = message.media.audio;
          } else if (message.media.voice) {
            uploadOptions.file = message.media.voice;
            uploadOptions.voiceNote = true;
          }
        }
      }
      
      // Handle special media types
      if (message.media.poll) {
        // For polls, create a text message with poll data
        const pollData = message.media.poll;
        uploadOptions.message = `📊 Poll: ${pollData.question}\n\nOptions:\n${pollData.answers.map((ans, i) => `${i + 1}. ${ans.text}`).join('\n')}\n\n${originalCaption}`;
        delete uploadOptions.file;
      } else if (message.media.geo) {
        // For location, send as venue or text
        const geo = message.media.geo;
        uploadOptions.message = `📍 Location: ${geo.lat}, ${geo.long}\n\n${originalCaption}`;
        delete uploadOptions.file;
      } else if (message.media.contact) {
        // For contacts, send contact info
        const contact = message.media.contact;
        uploadOptions.message = `👤 Contact: ${contact.firstName} ${contact.lastName || ''}\nPhone: ${contact.phoneNumber}\n\n${originalCaption}`;
        delete uploadOptions.file;
      } else if (message.media.venue) {
        // For venues, send venue info
        const venue = message.media.venue;
        uploadOptions.message = `🏢 Venue: ${venue.title}\nAddress: ${venue.address}\n\n${originalCaption}`;
        delete uploadOptions.file;
      } else if (message.media.webpage) {
        // For web pages, include URL
        const webpage = message.media.webpage;
        uploadOptions.message = `🔗 ${webpage.title || 'Webpage'}\n${webpage.url}\n${webpage.description || ''}\n\n${originalCaption}`;
        delete uploadOptions.file;
      }
      
    } else if (message.sticker) {
      // Handle stickers
      uploadOptions.file = message.sticker;
      uploadOptions.sticker = true;
    } else {
      // Text-only message
      if (!originalCaption.trim()) {
        logger.warn(`Message ${message.id} has no content to upload`);
        return false;
      }
    }

    // Send the message with preserved formatting
    const result = await client.sendMessage(targetChannelId, uploadOptions);
    return result;

  } catch (error) {
    throw new Error(`Failed to upload message: ${error.message}`);
  }
};

/**
 * Forward a message to target channel
 * @param {Object} client Telegram client
 * @param {string} targetChannelId Target channel ID
 * @param {string} sourceChannelId Source channel ID
 * @param {number} messageId Message ID to forward
 */
const forwardMessageToChannel = async (client, targetChannelId, sourceChannelId, messageId) => {
  try {
    const result = await client.forwardMessages(targetChannelId, {
      messages: [messageId],
      fromPeer: sourceChannelId,
      silent: true
    });
    return result;
  } catch (error) {
    throw new Error(`Failed to forward message: ${error.message}`);
  }
};

module.exports = {
  getMessages,
  getMessageDetail,
  downloadMessageMedia,
  uploadMessageToChannel,
  forwardMessageToChannel,
};
