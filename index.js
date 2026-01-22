require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");
const { Telegraf } = require("telegraf");
const fs = require("fs-extra");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const File = require("./models/File");
const Folder = require("./models/Folder");
const cron = require("node-cron");
const { Server } = require("socket.io");
const http = require("http");
const axios = require("axios");

sharp.cache(false)

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("disconnect", () => console.log("❌ Frontend Disconnected"));
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_CHAT_ID;
const apiId = 34981332;
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION_STRING || "");

// --- INITIALIZE GRAMJS ---
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

(async () => {
  console.log("🔄 Connecting to Telegram via MTProto...");
  await client.start({
    botAuthToken: BOT_TOKEN,
  });
  console.log("✅ GramJS Connected! 2GB Uploads Enabled.");
})();
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ DB Error:", err));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});

const compressVideo = (inputPath, outputPath, socketId) => {
  return new Promise((resolve, reject) => {
    console.log("🎬 Starting HQ Mobile Compression...");

    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      // 🟢 RESIZE: Keep 1080p limit (Vital for old phones), but don't upscale small videos
      .outputOptions([
        "-vf scale='min(1920,iw)':-2",

        "-crf 23", // 🟢 23 = The perfect balance (Visually clear, reasonable size)
        "-preset fast", // Encode speed

        "-c:a aac", // Audio Codec
        "-b:a 192k", // 🟢 192kbps Audio (Crystal clear, near-transparency)
        "-ac 2", // Force Stereo (Fixes issues with 5.1/7.1 audio on phones)

        "-movflags +faststart", // Instant play
        "-pix_fmt yuv420p", // Android Compatibility
        "-profile:v main", // Compatibility Profile
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

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res
      .status(400)
      .json({ success: false, error: "Password is required" });
  }

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

app.get("/api/files", async (req, res) => {
  try {
    const File = require("./models/File");
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
    const File = require("./models/File");
    const files = await File.find({ isDeleted: true }).sort({ deletedAt: -1 });
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/files/:id", async (req, res) => {
  try {
    const File = require("./models/File");

    // Mark as deleted instead of removing
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
    const File = require("./models/File");
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
    const File = require("./models/File");
    await File.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Permanently Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

cron.schedule("0 0 * * *", async () => {
  console.log("🧹 Running Bin Cleanup...");
  const File = require("./models/File");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await File.deleteMany({
    isDeleted: true,
    deletedAt: { $lt: thirtyDaysAgo },
  });

  console.log(`🧹 Cleanup Complete: Deleted ${result.deletedCount} old files.`);
});

app.get("/api/folders", async (req, res) => {
  try {
    const folders = await Folder.find().sort({ createdAt: -1 });
    res.json({ success: true, data: folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
        console.log(
          `✅ Telegram Topic Created: ${name} (ID: ${telegramTopicId})`,
        );
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
    console.error("Folder Save Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/files/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  const { path: localPath, originalname, mimetype, size } = req.file;
  const { folderId } = req.body;

  const isHeic = originalname.toLowerCase().endsWith(".heic");
  const isVideo = mimetype.startsWith("video");

  let thumbPath = path.join(path.dirname(localPath), `thumb_${Date.now()}.jpg`);
  let thumbId = null;

  try {
    let finalFileName = originalname;
    let topicId = null;

    if (folderId && folderId !== "null") {
      const folder = await Folder.findById(folderId);
      if (folder) {
        const ext = path.extname(originalname);
        const safeFolderName = folder.name.replace(/\s+/g, "_");
        finalFileName = `${safeFolderName}_${Date.now()}${ext}`;
        topicId = folder.telegramTopicId;
      }
    }

    if (isHeic) {
      const inputBuffer = await fs.readFile(localPath);
      const jpgBuffer = await heicConvert({
        buffer: inputBuffer,
        format: "JPEG",
        quality: 1.0,
      });
      await sharp(jpgBuffer)
        .resize(320, 320, { fit: "cover" })
        .jpeg({ quality: 90 })
        .toFile(thumbPath);
    } else if (isVideo) {
      await generateVideoThumbnail(localPath, thumbPath);
    } else {
      thumbPath = null;
    }
    const extraParams = { caption: `File: ${finalFileName}` };
    if (topicId) extraParams.message_thread_id = topicId;
    if (thumbPath)
      extraParams.thumbnail = { source: fs.createReadStream(thumbPath) };

    const telegramResponse = await bot.telegram.sendDocument(
      CHAT_ID,
      { source: fs.createReadStream(localPath), filename: finalFileName },
      extraParams,
    );

    const doc = telegramResponse.document;
    if (doc.thumbnail) thumbId = doc.thumbnail.file_id;
    else if (doc.thumb) thumbId = doc.thumb.file_id;

    if (!thumbId && thumbPath) {
      try {
        const msg = await bot.telegram.sendPhoto(
          CHAT_ID,
          { source: fs.createReadStream(thumbPath) },
          { caption: "Hidden Thumb" },
        );
        thumbId = msg.photo[0].file_id;
      } catch (e) {
        console.log("Manual thumb upload failed", e);
      }
    }

    const newFile = await File.create({
      name: finalFileName,
      type: isHeic ? "img" : isVideo ? "video" : "doc",
      size: formatBytes(size),
      folderId: folderId !== "null" ? folderId : null,
      telegramFileId: doc.file_id,
      thumbnailFileId: thumbId,
      uploadedBy: "Dikshant",
    });

    res.status(201).json({ success: true, data: newFile });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (await fs.pathExists(localPath)) await fs.unlink(localPath);
    if (thumbPath && (await fs.pathExists(thumbPath)))
      await fs.unlink(thumbPath);
  }
});

app.get("/health", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>FamilyCloud | System Status</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg: #0f1014;
                --card: #16161a;
                --primary: #6366f1;
                --success: #10b981;
                --text: #ffffff;
                --text-dim: #9ca3af;
            }
            body {
                font-family: 'Inter', sans-serif;
                background-color: var(--bg);
                color: var(--text);
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
            }
            .status-card {
                background: var(--card);
                padding: 2rem;
                border-radius: 20px;
                border: 1px solid rgba(255,255,255,0.1);
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                text-align: center;
                max-width: 400px;
                width: 90%;
            }
            .pulse-container {
                display: flex;
                justify-content: center;
                align-items: center;
                margin-bottom: 1.5rem;
            }
            .pulse {
                width: 12px;
                height: 12px;
                background: var(--success);
                border-radius: 50%;
                box-shadow: 0 0 0 rgba(16, 185, 129, 0.4);
                animation: pulse 2s infinite;
            }
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
                70% { box-shadow: 0 0 0 15px rgba(16, 185, 129, 0); }
                100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
            }
            h1 { font-size: 1.5rem; margin: 0.5rem 0; font-weight: 600; }
            p { color: var(--text-dim); font-size: 0.9rem; }
            .badge {
                display: inline-block;
                padding: 4px 12px;
                background: rgba(16, 185, 129, 0.1);
                color: var(--success);
                border-radius: 20px;
                font-size: 0.75rem;
                font-weight: 600;
                margin-top: 1rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .divider {
                height: 1px;
                background: rgba(255,255,255,0.05);
                margin: 1.5rem 0;
            }
            .stats {
                display: flex;
                justify-content: space-around;
                font-size: 0.8rem;
                color: var(--text-dim);
            }
        </style>
    </head>
    <body>
        <div class="status-card">
            <div class="pulse-container">
                <div class="pulse"></div>
            </div>
            <h1>System Operational</h1>
            <p>OurFamilyCloud API is running smoothly on Render.</p>
            <div class="badge">Connection Secure</div>
            <div class="divider"></div>
            <div class="stats">
                <div>Uptime: 99.9%</div>
                <div>Server: Node.js</div>
                <div>Latency: Low</div>
            </div>
        </div>
    </body>
    </html>
  `);
});

app.post(
  "/api/files/upload-multiple",
  upload.array("files"),
  async (req, res) => {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No files" });

    const { folderId, uploadedBy, socketId } = req.body;
    const uploadedFiles = [];
    const errors = [];
    const File = require("./models/File");
    const Folder = require("./models/Folder");

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      let { path: localPath, originalname, mimetype, size } = file;

      // Check types
      const isHeic = originalname.toLowerCase().endsWith(".heic");
      const isVideo = mimetype.startsWith("video");
      const isImage = mimetype.startsWith("image") || isHeic;

      // Prepare paths
      let thumbPath = path.join(
        path.dirname(localPath),
        `thumb_${Date.now()}_${Math.random()}.jpg`,
      );
      let compressedPath = null;
      let finalUploadPath = localPath;
      let finalFileName = originalname;

      // IDs
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

        // 🟢 1. HEIC FIX
        if (isHeic) {
          console.log(`🍏 Converting HEIC to JPG: ${originalname}`);
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

        // 2. FOLDER LOGIC
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

        // 🟢 3. OPTIMIZATION & COMPRESSION
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
            await sharp(localPath, { failOnError: false })
              .rotate()
              .jpeg({ quality: 90, mozjpeg: true })
              .toFile(compressedPath);
            finalUploadPath = compressedPath;
            if (!finalFileName.toLowerCase().endsWith(".jpg")) {
              finalFileName = finalFileName.replace(/\.[^/.]+$/, "") + ".jpg";
            }
          } catch (optErr) {
            console.warn(`⚠️ Optimization failed, uploading original.`);
            finalUploadPath = localPath;
            compressedPath = null;
          }

          // Generate Thumbnail (For Grid View)
          try {
            await sharp(finalUploadPath, { failOnError: false })
              .resize(320, 320, { fit: "cover" })
              .jpeg({ quality: 80 })
              .toFile(thumbPath);
          } catch (e) {
            console.log("Thumbnail failed:", e.message);
          }
          const stats = await fs.stat(finalUploadPath);
          size = stats.size;
        } else if (isVideo) {
          console.log(`🎥 Converting Video (High Fidelity): ${finalFileName}`);

          // 1. Generate Thumbnail (Crucial for Grid View)
          await generateVideoThumbnail(localPath, thumbPath);

          // 2. High-Fidelity Compression
          compressedPath = path.join(
            path.dirname(localPath),
            `hq_${Date.now()}_${Math.random()}.mp4`,
          );

          await compressVideo(localPath, compressedPath, socketId);

          finalUploadPath = compressedPath;
          finalFileName = finalFileName.replace(/\.[^/.]+$/, "") + ".mp4";

          const stats = await fs.stat(compressedPath);
          size = stats.size;
        }

        // 🟢 4. PREVIEW ARTIFACT LOGIC
        // - Images: Create a separate high-quality preview.
        // - Videos: SKIP THIS. We leave previewFileId = null so the frontend plays the main video.
        if (isImage) {
          try {
            console.log(`📸 Generating HQ Preview for Image: ${finalFileName}`);
            const previewMsg = await bot.telegram.sendPhoto(
              CHAT_ID,
              { source: fs.createReadStream(finalUploadPath) },
              { caption: "Preview Artifact" },
            );
            const bestPhoto = previewMsg.photo[previewMsg.photo.length - 1];
            previewFileId = bestPhoto.file_id;
          } catch (err) {
            console.log(
              "Preview generation skipped (will use GramJS thumb):",
              err.message,
            );
          }
        }

        // 🟢 5. UPLOAD TO CLOUD (USING GRAMJS / MTPROTO)
        if (socketId)
          io.to(socketId).emit("uploadProgress", {
            stage: "cloud_upload",
            percent: 0,
          });

        console.log(
          `🚀 Uploading with GramJS: ${finalFileName} (${formatBytes(size)})`,
        );

        const hasThumb = thumbPath && (await fs.pathExists(thumbPath));

        const resultMessage = await client.sendFile(CHAT_ID, {
          file: finalUploadPath,
          caption: `File: ${finalFileName}`,
          forceDocument: !isImage && !isVideo, // Force doc for non-media
          thumb: hasThumb ? thumbPath : undefined,
          replyTo: topicId ? parseInt(topicId) : undefined,

          progressCallback: (uploaded, total) => {
            const percent = Math.round((uploaded / total) * 100);
            if (socketId && percent % 5 === 0) {
              io.to(socketId).emit("uploadProgress", {
                stage: "cloud_upload",
                percent: percent,
              });
            }
          },
        });

        // 🟢 6. SAVE TO DB
        const msgId = resultMessage.id;

        const newFile = await File.create({
          name: finalFileName,
          type: isImage ? "img" : isVideo ? "video" : "doc",
          size: formatBytes(size),
          folderId: folderId !== "null" ? folderId : null,

          // Store Message ID (Crucial for GramJS retrieval)
          telegramMessageId: msgId,
          telegramFileId: msgId.toString(),

          // Preview Logic:
          // Images -> Use the dedicated ID we created in Step 4.
          // Videos -> Null. Frontend checks this and streams the main video.
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
        // CLEANUP
        try {
          if (await fs.pathExists(localPath)) await fs.unlink(localPath);
          if (compressedPath && (await fs.pathExists(compressedPath)))
            await fs.unlink(compressedPath);
          if (thumbPath && (await fs.pathExists(thumbPath)))
            await fs.unlink(thumbPath);
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

app.get("/api/files/preview/:id", async (req, res) => {
  try {
    const fileDoc = await File.findById(req.params.id);
    if (!fileDoc) return res.status(404).send("File not found");
    if (fileDoc.previewFileId) {
      try {
        const link = await bot.telegram.getFileLink(fileDoc.previewFileId);
        return res.redirect(link.href);
      } catch (e) {
        console.log("HQ Preview link failed, trying fallback...");
      }
    }
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
          if (buffer) {
            res.writeHead(200, {
              "Content-Type": "image/jpeg",
              "Content-Length": buffer.length,
              "Cache-Control": "public, max-age=86400",
            });
            return res.end(buffer);
          }
        }
      } catch (e) {
        console.error("GramJS Fallback Failed:", e.message);
      }
    }
    if (fileDoc.telegramFileId && fileDoc.type === "img") {
      try {
        const link = await bot.telegram.getFileLink(fileDoc.telegramFileId);
        return res.redirect(link.href);
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
        // Fetch message using CHAT_ID to ensure peer context is valid
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
            res.setHeader("Accept-Ranges", "bytes");

            // Use the full media object for downloading
            const stream = client.iterDownload({
              file: message.media,
              requestSize: 1024 * 1024,
            });

            for await (const chunk of stream) {
              res.write(chunk);
            }
            return res.end();
          }
        }
      } catch (e) {
        console.error("GramJS Stream Failed:", e.message);
      }
    }

    // Fallback to bot link for smaller/older files
    if (fileDoc.telegramFileId && fileDoc.telegramFileId.length > 10) {
      const link = await bot.telegram.getFileLink(fileDoc.telegramFileId);
      return res.redirect(link.href);
    }

    if (!res.headersSent) res.status(404).send("Media unavailable");
  } catch (err) {
    if (!res.headersSent) res.status(500).send("Server Error");
  }
});

app.patch("/api/folders/:id/toggle-public", async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    // 1. Toggle the Boolean
    folder.isPublic = !folder.isPublic;

    // 2. Generate a Share ID if it doesn't exist yet
    if (folder.isPublic && !folder.shareId) {
      // Create a random 8-character string (e.g., "a1b2c3d4")
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
    }).sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      data: {
        folder: folder,
        files: files,
      },
    });
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
    console.error("Recent Error:", err);
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

server.listen(5000, () => {
  console.log("🚀 Server running on port 5000");
});
