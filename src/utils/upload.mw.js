import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { cloudinary } from "../config/cloudinary.config.js";

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/mpeg",
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only images, videos, PDF, and DOC files are allowed"), false);
  }
};

export const mediaUpload = multer({
  storage: new CloudinaryStorage({
    cloudinary,
    params: (req, file) => {
      let folder = "Storywave/Media";
      let resource_type = "auto";

      if (file.mimetype.startsWith("image")) {
        folder = "Storywave/Images";
        resource_type = "image";
      } else if (file.mimetype.startsWith("video")) {
        folder = "Storywave/Videos";
        resource_type = "video";
      } else if (file.mimetype === "application/pdf") {
        folder = "Storywave/PDFs";
      } else if (
        file.mimetype === "application/msword" ||
        file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        folder = "Storywave/Documents";
      }

      return {
        folder,
        resource_type,
        chunk_size: 20000000, // 20MB chunks for large files like 800MB video
      };
    },
  }),
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5 GB limit
  },
});
