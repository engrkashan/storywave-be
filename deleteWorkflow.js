import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function deleteBadWorkflows() {
    try {
        console.log("🔍 Fetching workflows with status PENDING or FAILED...");

        const workflows = await prisma.workflow.findMany({
            where: {
                status: { in: ["PENDING", "FAILED"] }
            },
            include: {
                inputs: true,
                tasks: true,
                media: true,
                voiceover: true,
                story: true,
                video: true,
                podcast: {
                    include: {
                        episodes: true
                    }
                }
            }
        });

        if (workflows.length === 0) {
            console.log("✅ No workflows to delete.");
            return;
        }

        console.log(`🗑️ Found ${workflows.length} workflows to delete.`);

        for (const wf of workflows) {
            console.log(`\n----------------------------------------`);
            console.log(`🗑️ Deleting workflow: ${wf.id} (${wf.status})`);

            // 1️⃣ Delete INPUT records
            if (wf.inputs.length > 0) {
                await prisma.input.deleteMany({
                    where: { workflowId: wf.id }
                });
                console.log(`   ➤ Deleted Inputs: ${wf.inputs.length}`);
            }

            // 2️⃣ Delete TASK records
            if (wf.tasks.length > 0) {
                await prisma.task.deleteMany({
                    where: { workflowId: wf.id }
                });
                console.log(`   ➤ Deleted Tasks: ${wf.tasks.length}`);
            }

            // 3️⃣ Delete MEDIA
            if (wf.media.length > 0) {
                await prisma.media.deleteMany({
                    where: { workflowId: wf.id }
                });
                console.log(`   ➤ Deleted Media: ${wf.media.length}`);
            }

            // 4️⃣ Delete VOICEOVER
            if (wf.voiceover) {
                await prisma.voiceover.delete({
                    where: { workflowId: wf.id }
                });
                console.log(`   ➤ Deleted Voiceover`);
            }

            // 5️⃣ Delete STORY
            if (wf.storyId) {
                await prisma.story.delete({
                    where: { id: wf.storyId }
                });
                console.log(`   ➤ Deleted Story`);
            }

            // 6️⃣ Delete VIDEO
            if (wf.videoId) {
                await prisma.video.delete({
                    where: { id: wf.videoId }
                });
                console.log(`   ➤ Deleted Video`);
            }

            // 7️⃣ Delete PODCAST + EPISODES
            if (wf.podcast) {
                // Delete episodes first
                await prisma.episode.deleteMany({
                    where: { podcastId: wf.podcast.id }
                });

                // Delete podcast
                await prisma.podcast.delete({
                    where: { workflowId: wf.id }
                });

                console.log(`   ➤ Deleted Podcast + Episodes`);
            }

            // 8️⃣ Finally delete the WORKFLOW itself
            await prisma.workflow.delete({
                where: { id: wf.id }
            });

            console.log(`   🚮 Workflow removed successfully.`);
        }

        console.log("\n🎉 ALL PENDING/FAILED WORKFLOWS HAVE BEEN CLEANED");
    } catch (err) {
        console.error("❌ Error deleting workflows:", err);
    } finally {
        await prisma.$disconnect();
    }
}

deleteBadWorkflows();
