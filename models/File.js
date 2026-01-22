const mongoose = require("mongoose");

const FileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    default: "doc",
  },
  size: {
    type: String,
    required: false,
  },
  folderId: {
    type: String,
    default: null,
  },

  // 🟢 NEW: GramJS needs this to find the file!
  telegramMessageId: {
    type: Number,
    required: false, // Optional because old files won't have it
  },

  // Keep this for backward compatibility (Telegraf files)
  telegramFileId: {
    type: String,
    required: false, // Changed to false so it doesn't break if we only have a Msg ID
  },

  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },

  thumbnailFileId: { type: String },
  previewFileId: { type: String, default: null },

  createdAt: {
    type: Date,
    default: Date.now,
  },
  uploadedBy: { type: String, default: "Dikshant" },
});

module.exports = mongoose.model("File", FileSchema);
