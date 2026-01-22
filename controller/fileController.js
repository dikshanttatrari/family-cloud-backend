const fs = require("fs-extra");
const { Telegraf } = require("telegraf");
const File = require("../models/File");
const Folder = require("../models/Folder");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const heicConvert = require("heic-convert");
const axios = require("axios");
const FormData = require("form-data");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const generateVideoThumbnail = (videoPath, thumbPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [1],
        filename: path.basename(thumbPath),
        folder: path.dirname(thumbPath),
        size: "320x?",
      })
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });
};

const uploadThumbnailToTelegram = async (thumbPath) => {
  try {
    const msg = await bot.telegram.sendPhoto(
      CHAT_ID,
      { source: fs.createReadStream(thumbPath) },
      { caption: "Hidden Thumbnail" },
    );
    return msg.photo[0].file_id;
  } catch (error) {
    console.error("Manual Thumb Upload Error:", error);
    return null;
  }
};

exports.uploadFile = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const { path: localPath, originalname, mimetype, size } = req.file;
  const { folderId } = req.body;
  const isHeic = originalname.toLowerCase().endsWith(".heic");
  const isVideo = mimetype.startsWith("video");

  let thumbPath = null;
  let thumbId = null;

  try {
    let finalFileName = originalname;
    let topicId = null;

    if (folderId && folderId !== "null") {
      const folder = await Folder.findById(folderId);
      if (folder) {
        const ext = path.extname(originalname);
        const timestamp = Date.now();
        const safeFolderName = folder.name.replace(/\s+/g, "_");
        finalFileName = `${safeFolderName}_${timestamp}${ext}`;
        topicId = folder.telegramTopicId;
      }
    }

    if (isHeic) {
      thumbPath = localPath + "_thumb.jpg";
      const inputBuffer = await fs.readFile(localPath);
      const outputBuffer = await heicConvert({
        buffer: inputBuffer,
        format: "JPEG",
        quality: 0.4,
      });
      await fs.writeFile(thumbPath, outputBuffer);
    } else if (isVideo) {
      thumbPath = localPath + "_thumb.jpg";
      await generateVideoThumbnail(localPath, thumbPath);
    }

    // 🟢 3. PREPARE UPLOAD PARAMS
    const extraParams = {
      caption: `File: ${finalFileName}`, // Updated caption
    };

    if (topicId) {
      extraParams.message_thread_id = topicId;
    }

    if (thumbPath) {
      extraParams.thumbnail = { source: fs.createReadStream(thumbPath) };
    }

    // 🟢 4. SEND TO TELEGRAM WITH NEW NAME
    const telegramResponse = await bot.telegram.sendDocument(
      CHAT_ID,
      {
        source: fs.createReadStream(localPath),
        filename: finalFileName, // Use the new name here
      },
      extraParams,
    );

    const doc = telegramResponse.document;
    if (doc.thumbnail) thumbId = doc.thumbnail.file_id;
    else if (doc.thumb) thumbId = doc.thumb.file_id;

    if (!thumbId && thumbPath) {
      console.log(
        "⚠️ Telegram didn't return a thumb ID. Uploading manually...",
      );
      thumbId = await uploadThumbnailToTelegram(thumbPath);
    }

    // 🟢 5. SAVE TO DB WITH NEW NAME
    const newFile = await File.create({
      name: finalFileName, // Save new name to DB
      type: isHeic ? "img" : isVideo ? "video" : "doc",
      size: formatBytes(size),
      folderId: folderId !== "null" ? folderId : null,
      telegramFileId: doc.file_id,
      thumbnailFileId: thumbId,
      uploadedBy: "Dikshant",
    });

    res.status(201).json({ success: true, data: newFile });
  } catch (error) {
    console.error("Upload Logic Error:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (await fs.pathExists(localPath)) await fs.unlink(localPath);
    if (thumbPath && (await fs.pathExists(thumbPath)))
      await fs.unlink(thumbPath);
  }
};
exports.previewFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).send("File not found");
    let targetId = file.thumbnailFileId;
    if (!targetId && file.type === "img" && !file.name.endsWith(".heic")) {
      targetId = file.telegramFileId;
    }

    if (!targetId) {
      return res.status(404).send("No preview available");
    }

    const link = await bot.telegram.getFileLink(targetId);
    res.redirect(link.href);
  } catch (error) {
    console.error("Preview Error:", error);
    res.status(500).send("Error loading preview");
  }
};

exports.downloadFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    const link = await bot.telegram.getFileLink(file.telegramFileId);
    res.redirect(link.href);
  } catch (error) {
    console.error("Download Error:", error);
    res
      .status(500)
      .json({ success: false, error: "Could not generate download link" });
  }
};

exports.getAllFiles = async (req, res) => {
  try {
    const files = await File.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: files });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
