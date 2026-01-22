const mongoose = require("mongoose");

const FolderSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  telegramTopicId: {
    type: Number,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  isPublic: { type: Boolean, default: false },
  shareId: {
    type: String,
    unique: true,
    default: () => Math.random().toString(36).substring(2, 9),
  },
});

module.exports = mongoose.model("Folder", FolderSchema);
