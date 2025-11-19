import { processExistingWorkflow } from "../services/workflowService.js";
import { prisma } from "../lib/prisma.js";

let isProcessing = false;

export async function runScheduledWorkflows() {
  if (isProcessing) {
    console.log("⏳ A workflow is already processing... skipping this tick.");
    return;
  }

  isProcessing = true;

  try {
    const now = new Date();

    const workflow = await prisma.workflow.findFirst({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: "asc" }
    });

    if (!workflow) {
      isProcessing = false;
      return;
    }

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });

    await processExistingWorkflow(workflow);

  } catch (err) {
    console.error("Scheduler error:", err);
  }

  isProcessing = false;
}
