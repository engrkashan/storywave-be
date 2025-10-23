import prisma from "../config/prisma.client.js";

// GET all Stories (for current admin)
export const getStories = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const stories = await prisma.story.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        Workflow: {
          include: {
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    // Flatten the workflows and return only relevant story media
    const result = stories.map((story) => ({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media: story.Workflow.flatMap((wf) => wf.media || []),
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error("Get Stories Error:", error);
    return res.status(500).json({ error: "Failed to fetch stories" });
  }
};

// GET single Story with mp4 media only
export const getStoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await prisma.story.findUnique({
      where: { id },
      include: {
        Workflow: {
          include: {
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const media = story.Workflow.flatMap((wf) => wf.media || []);

    return res.status(200).json({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media,
    });
  } catch (error) {
    console.error("Get Story Error:", error);
    return res.status(500).json({ error: "Failed to fetch story" });
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
