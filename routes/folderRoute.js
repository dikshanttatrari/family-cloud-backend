const router = require("express").Router();
const mongoose = require("mongoose");
const axios = require("axios");
const Folder = require("../models/Folder");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_CHAT_ID;

router.get("/", async (req, res) => {
  try {
    const folders = await Folder.find().sort({ createdAt: -1 });
    res.json({ success: true, data: folders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/", async (req, res) => {
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

module.exports = router;
