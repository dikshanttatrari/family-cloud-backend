const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  uploadFile,
  downloadFile,
  getAllFiles,
  previewFile,
  uploadMultipleFiles,
} = require("../controller/fileController");

const upload = multer({ dest: "uploads/" });
router.post("/upload", upload.single("file"), uploadFile);
router.get("/download/:id", downloadFile);
router.get("/", getAllFiles);
router.get("/preview/:id", previewFile);
// router.post("/upload-multiple", upload.array("files", 10), uploadMultipleFiles);
module.exports = router;
