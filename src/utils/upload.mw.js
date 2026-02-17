import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { cloudinary } from "../config/cloudinary.config.js";

// Allowed MIME types
const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Only images, PDF, and DOC files are allowed"), false);
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
      };
    },
  }),
  fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});
