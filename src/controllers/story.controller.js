import prisma from "../config/prisma.client.js";

// CREATE Story
export const createStory = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const { title, content, mediaURL } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required" });
    }

    const story = await prisma.story.create({
      data: {
        title,
        content,
        mediaURL,
        adminId: userId,
      },
    });

    return res
      .status(200)
      .json({ message: "Story created successfully", story });
  } catch (error) {
    console.error("Create Story Error:", error);
    return res.status(500).json({ error: "Failed to create story" });
  }
};

// GET all Stories (for current admin)
export const getStories = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const stories = await prisma.story.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json(stories);
  } catch (error) {
    console.error("Get Stories Error:", error);
    return res.status(500).json({ error: "Failed to fetch stories" });
  }
};

// GET single Story
export const getStoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await prisma.story.findUnique({
      where: { id },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    return res.status(200).json(story);
  } catch (error) {
    console.error("Get Story Error:", error);
    return res.status(500).json({ error: "Failed to fetch story" });
  }
};

// UPDATE Story
export const updateStory = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, mediaURL } = req.body;

    const existing = await prisma.story.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Story not found" });
    }

    const updated = await prisma.story.update({
      where: { id },
      data: {
        title: title ?? existing.title,
        content: content ?? existing.content,
        mediaURL: mediaURL ?? existing.mediaURL,
        updatedAt: new Date(),
      },
    });

    return res
      .status(200)
      .json({ message: "Story updated successfully", story: updated });
  } catch (error) {
    console.error("Update Story Error:", error);
    return res.status(500).json({ error: "Failed to update story" });
  }
};

// DELETE Story
export const deleteStory = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.story.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Story not found" });
    }

    await prisma.story.delete({ where: { id } });

    return res.status(200).json({ message: "Story deleted successfully" });
  } catch (error) {
    console.error("Delete Story Error:", error);
    return res.status(500).json({ error: "Failed to delete story" });
  }
};
