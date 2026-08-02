CREATE TABLE "worker_control" (
    "id" TEXT NOT NULL,
    "queue_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_control_pkey" PRIMARY KEY ("id")
);

INSERT INTO "worker_control" ("id", "queue_paused")
VALUES ('global', false);
