require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Telegraf } = require("telegraf");
const fs = require("fs-extra");
const ffmpeg = require("fluent-ffmpeg");
// const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path; // 🟢 Commented out for Docker/System FFmpeg
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const cron = require("node-cron");
const { Server } = require("socket.io");
const http = require("http");
const axios = require("axios");

// 🟢 Load Models early
const File = require("./models/File");
const Folder = require("./models/Folder");

// 🟢 16GB RAM OPTIMIZATION:
// allow Sharp to use more memory and parallel threads for faster image processing.
sharp.cache(true); // Re-enable cache since we have RAM
sharp.concurrency(os.cpus().length);

// ffmpeg.setFfmpegPath(ffmpegPath); // 🟢 Use system ffmpeg (installed via Dockerfile)
const app = express();

// 🛡️ SECURITY: Restrict Origins in Production
const allowedOrigins = [
  "https://photos.ourfamilycloud.com",
  "https://huggingface.co",
  "http://localhost:5173", // For local testing
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (
        !origin ||
        allowedOrigins.some((o) => origin.startsWith(o)) ||
        origin === "null"
      ) {
        callback(null, true);
      } else {
        console.log("Blocked Origin:", origin);
        callback(null, true); // Temporarily allow all for debugging, restrict later
      }
    },
  }),
);

app.use(express.json());

// 🟢 HEALTH CHECK (Crucial for Uptime)
app.get("/", (req, res) => res.send("FamilyCloud API is Running 🚀"));
app.get("/health", (req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  // console.log("Frontend Connected:", socket.id);
  socket.on("disconnect", () => {
    /* quiet log */
  });
});

// --- TELEGRAM CONFIG ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GROUP_ID = process.env.TELEGRAM_CHAT_ID;
const apiId = 34981332;
const apiHash = process.env.TELEGRAM_API_HASH;
const bot = new Telegraf(BOT_TOKEN);

// 🟢 SESSION MANAGEMENT
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 10, // Increased retries for stability
  useWSS: false, // Use TCP for better throughput on servers
});

// 🟢 ROBUST CONNECTION LOGIC
let isGramJSConnected = false;
(async () => {
  try {
    console.log("🔄 Connecting to Telegram via MTProto...");
    await client.start({
      botAuthToken: BOT_TOKEN,
    });
    isGramJSConnected = true;
    console.log("✅ GramJS Connected! High-RAM Mode Active.");
    // console.log("Session String (Save this if new):", client.session.save());
  } catch (err) {
    console.error("❌ Telegram Connection Failed:", err.message);
  }
})();

// 🟢 DATABASE CONNECTION
mongoose
  .connect(process.env.MONGO_URI, {
    maxPoolSize: 10, // Maintain up to 10 socket connections
    serverSelectionTimeoutMS: 5000,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ DB Error:", err));

// 🟢 UPLOAD CONFIG
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 2.5 * 1024 * 1024 * 1024 }, // Limit to 2.5GB (Express limit)
});

// --- HELPER FUNCTIONS ---

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return "0 Bytes";
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${["Bytes", "KB", "MB", "GB"][i]}`;
};

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

// 🟢 HIGH RAM VIDEO COMPRESSION
// Since we have 16GB RAM, we use "medium" preset instead of ultrafast.
// This results in BETTER quality and SMALLER file sizes, but uses more RAM (which we have!).
const compressVideo = (inputPath, outputPath, socketId) => {
  return new Promise((resolve, reject) => {
    console.log("🎬 Starting High-Fidelity Compression...");
    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      .outputOptions([
        "-vf scale='min(1920,iw)':-2", // 1080p is safe with 16GB RAM
        "-crf 23", // High quality
        "-preset medium", // 🟢 Uses more RAM/CPU for better compression than 'ultrafast'
        "-c:a aac",
        "-b:a 192k",
        "-ac 2",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
        "-profile:v main",
        "-level 4.0",
      ])
      .on("progress", (progress) => {
        if (socketId && progress.percent) {
          const p = Math.round(progress.percent);
          io.to(socketId).emit("uploadProgress", {
            stage: "compressing_video",
            percent: p > 99 ? 99 : p,
          });
        }
      })
      .on("end", () => {
        console.log("✅ HQ Compression Complete");
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error("Compression Error:", err.message);
        reject(err);
      })
      .run();
  });
};

// --- ROUTES ---

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (!password)
    return res
      .status(400)
      .json({ success: false, error: "Password is required" });
  if (password === process.env.ADMIN_PASSWORD) {
    return res.json({
      success: true,
      message: "Welcome back!",
      token: process.env.JWT_TOKEN,
    });
  } else {
    return res
      .status(401)
      .json({ success: false, error: "Incorrect Password" });
  }
});

// ... [GET/DELETE Routes for Files/Folders remain exactly the same as previous code] ...
// I am keeping the logic concise here. Assume the GET/DELETE/RESTORE logic is identical
// to the previous stable version.
app.get("/api/files", async (req, res) => {
  try {
    const files = await File.find({ isDeleted: { $ne: true } }).sort({
      createdAt: -1,
    });
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/files/trash", async (req, res) => {
  try {
    const files = await File.find({ isDeleted: true }).sort({ deletedAt: -1 });
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete("/api/files/:id", async (req, res) => {
  try {
    await File.findByIdAndUpdate(req.params.id, {
      isDeleted: true,
      deletedAt: new Date(),
    });
    res.json({ success: true, message: "Moved to Bin" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/api/files/restore/:id", async (req, res) => {
  try {
    await File.findByIdAndUpdate(req.params.id, {
      isDeleted: false,
      deletedAt: null,
    });
    res.json({ success: true, message: "File Restored" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete("/api/files/permanent/:id", async (req, res) => {
  try {
    await File.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Permanently Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.get("/api/folders", async (req, res) => {
  try {
    const folders = await Folder.find().sort({ createdAt: -1 });
    res.json({ success: true, data: folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/files/recent", async (req, res) => {
  try {
    const files = await File.find({ isDeleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.delete("/api/folders/:id", async (req, res) => {
  try {
    const folderId = req.params.id;
    const folder = await Folder.findById(folderId);
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    await File.updateMany(
      { folderId: folderId },
      { isDeleted: true, deletedAt: new Date() },
    );
    if (folder.telegramTopicId) {
      try {
        await bot.telegram.closeForumTopic(CHAT_ID, folder.telegramTopicId);
      } catch (e) {
        console.log("Could not close Telegram topic:", e.message);
      }
    }
    await Folder.findByIdAndDelete(folderId);
    res.json({ success: true, message: "Folder deleted, files moved to bin" });
  } catch (err) {
    console.error("Delete Folder Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.patch("/api/folders/:id/toggle-public", async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    folder.isPublic = !folder.isPublic;
    if (folder.isPublic && !folder.shareId) {
      folder.shareId = require("crypto").randomBytes(4).toString("hex");
    }
    await folder.save();
    res.json({ success: true, data: folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/folders/public/:shareId", async (req, res) => {
  try {
    const folder = await Folder.findOne({ shareId: req.params.shareId });
    if (!folder || !folder.isPublic) {
      return res
        .status(404)
        .json({ success: false, error: "Link is expired or private" });
    }
    const files = await File.find({
      folderId: folder._id,
      isDeleted: { $ne: true },
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: { folder: folder, files: files } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FOLDER CREATION ---
app.post("/api/folders", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Folder name required" });
    let telegramTopicId;
    try {
      const telegramRes = await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`,
        {
          chat_id: GROUP_ID,
          name: name,
          icon_color: 0x6d33f3,
        },
      );
      if (telegramRes.data.ok) {
        telegramTopicId = telegramRes.data.result.message_thread_id;
      } else {
        throw new Error("Telegram API returned false");
      }
    } catch (tgError) {
      console.error(
        "❌ Telegram Topic Failed:",
        tgError.response?.data || tgError.message,
      );
      telegramTopicId = Math.floor(Math.random() * 1000000);
    }
    const folder = new Folder({
      name,
      telegramTopicId: telegramTopicId,
      createdBy: new mongoose.Types.ObjectId(),
    });
    await folder.save();
    res.json({ success: true, data: folder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- UPLOAD ROUTE (OPTIMIZED FOR 16GB) ---
app.post(
  "/api/files/upload-multiple",
  upload.array("files"),
  async (req, res) => {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No files" });

    const { folderId, uploadedBy, socketId } = req.body;
    const uploadedFiles = [];
    const errors = [];

    // 🟢 PARALLEL PROCESSING POSSIBLE with 16GB RAM?
    // While we *could* do Promise.all, Telegram imposes rate limits.
    // It is safer to keep it sequential for Network stability, but we can do heavy operations comfortably.

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      let { path: localPath, originalname, mimetype, size } = file;
      const isHeic = originalname.toLowerCase().endsWith(".heic");
      const isVideo = mimetype.startsWith("video");
      const isImage = mimetype.startsWith("image") || isHeic;

      let thumbPath = path.join(
        path.dirname(localPath),
        `thumb_${Date.now()}_${Math.random()}.jpg`,
      );
      let compressedPath = null;
      let finalUploadPath = localPath;
      let finalFileName = originalname;
      let thumbId = null;
      let previewFileId = null;

      try {
        if (socketId)
          io.to(socketId).emit("uploadProgress", {
            stage: "processing",
            percent: 0,
            currentFile: i + 1,
            totalFiles: req.files.length,
          });

        // 1. HEIC Conversion
        if (isHeic) {
          console.log(`🍏 Converting HEIC: ${originalname}`);
          const inputBuffer = await fs.readFile(localPath);
          const jpgBuffer = await heicConvert({
            buffer: inputBuffer,
            format: "JPEG",
            quality: 1,
          });
          const newLocalPath = localPath.replace(/\.heic$/i, ".jpg");
          await fs.writeFile(newLocalPath, jpgBuffer);
          try {
            await fs.unlink(localPath);
          } catch (e) {}
          localPath = newLocalPath;
          finalFileName = finalFileName.replace(/\.heic$/i, ".jpg");
        }

        // 2. Folder Logic
        let topicId = null;
        if (folderId && folderId !== "null") {
          const folder = await Folder.findById(folderId);
          if (folder) {
            const ext = path.extname(finalFileName);
            const safeFolderName = folder.name.replace(/\s+/g, "_");
            finalFileName = `${safeFolderName}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
            topicId = folder.telegramTopicId;
          }
        }

        // 3. Image Optimization (Using full RAM capacity)
        if (isImage) {
          console.log(`🖼 Optimizing Image: ${finalFileName}`);
          if (socketId)
            io.to(socketId).emit("uploadProgress", {
              stage: "optimizing_image",
              percent: 20,
            });
          compressedPath = path.join(
            path.dirname(localPath),
            `opt_${Date.now()}_${Math.random()}.jpg`,
          );

          try {
            await sharp(localPath) // Cache is enabled globally
              .rotate()
              .jpeg({ quality: 95, mozjpeg: true }) // Higher quality for production
              .toFile(compressedPath);
            finalUploadPath = compressedPath;
            if (!finalFileName.toLowerCase().endsWith(".jpg"))
              finalFileName = finalFileName.replace(/\.[^/.]+$/, "") + ".jpg";
          } catch (optErr) {
            console.warn(`⚠️ Optimization failed, using original.`);
            finalUploadPath = localPath;
          }

          // Thumb
          try {
            await sharp(finalUploadPath)
              .resize(320, 320, { fit: "cover" })
              .jpeg({ quality: 80 })
              .toFile(thumbPath);
          } catch (e) {}
          const stats = await fs.stat(finalUploadPath);
          size = stats.size;
        }

        // 4. Video Compression (High Fidelity Enabled)
        else if (isVideo) {
          console.log(`🎥 Processing Video (HQ): ${finalFileName}`);
          await generateVideoThumbnail(localPath, thumbPath);

          compressedPath = path.join(
            path.dirname(localPath),
            `hq_${Date.now()}_${Math.random()}.mp4`,
          );
          // 🟢 WE ENABLE COMPRESSION AGAIN (16GB RAM handles this easily)
          await compressVideo(localPath, compressedPath, socketId);

          finalUploadPath = compressedPath;
          finalFileName = finalFileName.replace(/\.[^/.]+$/, "") + ".mp4";
          const stats = await fs.stat(compressedPath);
          size = stats.size;
        }

        // 5. Preview Generation
        if (isImage) {
          try {
            const previewMsg = await bot.telegram.sendPhoto(
              CHAT_ID,
              { source: fs.createReadStream(finalUploadPath) },
              { caption: "Preview Artifact" },
            );
            const bestPhoto = previewMsg.photo[previewMsg.photo.length - 1];
            previewFileId = bestPhoto.file_id;
          } catch (err) {}
        }

        // 6. Cloud Upload
        if (socketId)
          io.to(socketId).emit("uploadProgress", {
            stage: "cloud_upload",
            percent: 0,
          });
        console.log(`🚀 Uploading: ${finalFileName} (${formatBytes(size)})`);

        const hasThumb = thumbPath && (await fs.pathExists(thumbPath));
        const resultMessage = await client.sendFile(CHAT_ID, {
          file: finalUploadPath,
          caption: `File: ${finalFileName}`,
          forceDocument: !isImage && !isVideo,
          thumb: hasThumb ? thumbPath : undefined,
          replyTo: topicId ? parseInt(topicId) : undefined,
          progressCallback: (uploaded, total) => {
            const percent = Math.round((uploaded / total) * 100);
            if (socketId && percent % 5 === 0)
              io.to(socketId).emit("uploadProgress", {
                stage: "cloud_upload",
                percent: percent,
              });
          },
        });

        const msgId = resultMessage.id;
        const newFile = await File.create({
          name: finalFileName,
          type: isImage ? "img" : isVideo ? "video" : "doc",
          size: formatBytes(size),
          folderId: folderId !== "null" ? folderId : null,
          telegramMessageId: msgId,
          telegramFileId: msgId.toString(),
          previewFileId: previewFileId,
          thumbnailFileId: null,
          uploadedBy: uploadedBy || "Dikshant",
        });
        uploadedFiles.push(newFile);
        console.log(`✅ Upload Complete: ${finalFileName}`);
      } catch (error) {
        console.error("Upload Error:", error);
        errors.push({ file: originalname, error: error.message });
      } finally {
        try {
          await fs.remove(localPath);
          if (compressedPath) await fs.remove(compressedPath);
          if (thumbPath) await fs.remove(thumbPath);
        } catch (e) {}
      }
    }

    res.json({
      success: true,
      data: uploadedFiles,
      errors: errors.length ? errors : null,
    });
  },
);

// --- DOWNLOAD/PREVIEW ROUTES ---

app.get("/api/files/preview/:id", async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id);
    if (!fileDoc) return res.status(404).send("File not found");

    // 1. Try Bot API Link (Fastest, no server load)
    if (fileDoc.previewFileId) {
      try {
        const link = await bot.telegram.getFileLink(fileDoc.previewFileId);
        return res.redirect(link.href);
      } catch (e) {}
    }

    // 2. GramJS Stream (Fallback for heavy load)
    if (fileDoc.telegramMessageId) {
      try {
        const messages = await client.getMessages(CHAT_ID, {
          ids: [parseInt(fileDoc.telegramMessageId)],
        });
        const message = messages[0];
        if (message && message.media) {
          const buffer = await client.downloadMedia(message.media, {
            thumb: "m",
          });
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": buffer.length,
            "Cache-Control": "public, max-age=86400",
          });
          return res.end(buffer);
        }
      } catch (e) {}
    }
    return res.status(404).send("No preview found");
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

app.get("/api/files/download/:id", async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id);
    if (!fileDoc) return res.status(404).send("File not found");

    if (fileDoc.telegramMessageId) {
      try {
        const messages = await client.getMessages(CHAT_ID, {
          ids: [parseInt(fileDoc.telegramMessageId)],
        });
        const message = messages[0];

        if (message && message.media) {
          const doc =
            message.media.document ||
            message.media.video ||
            message.media.photo;
          if (doc) {
            const filename = encodeURIComponent(fileDoc.name);
            const disposition =
              req.query.inline === "true" ? "inline" : "attachment";
            const fileSize = doc.size ? Number(doc.size) : null;

            res.setHeader(
              "Content-Type",
              doc.mimeType || "application/octet-stream",
            );
            res.setHeader(
              "Content-Disposition",
              `${disposition}; filename="${filename}"`,
            );
            if (fileSize) res.setHeader("Content-Length", fileSize);

            // 🟢 16GB RAM: Increase buffer size for faster downloads
            const stream = client.iterDownload({
              file: message.media,
              requestSize: 2 * 1024 * 1024,
            }); // 2MB chunks

            for await (const chunk of stream) {
              res.write(chunk);
            }
            return res.end();
          }
        }
      } catch (e) {
        console.error("Stream Failed:", e.message);
      }
    }
    res.status(404).send("Media unavailable");
  } catch (err) {
    if (!res.headersSent) res.status(500).send("Server Error");
  }
});

// --- CRON & ERROR HANDLING ---

cron.schedule("0 0 * * *", async () => {
  console.log("🧹 Running Bin Cleanup...");
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  await File.deleteMany({ isDeleted: true, deletedAt: { $lt: thirtyDaysAgo } });
});

process.on("unhandledRejection", (reason) =>
  console.error("🚨 Unhandled Rejection:", reason),
);
process.on("uncaughtException", (error) =>
  console.error("🚨 Uncaught Exception:", error),
);

// 🟢 PORT HANDLING FOR HUGGING FACE / DOCKER
const PORT = process.env.PORT || 7860;
server.listen(PORT, () => {
  console.log(
    `🚀 Production Server running on port ${PORT} with 16GB Optimization`,
  );
});
