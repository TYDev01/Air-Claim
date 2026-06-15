-- CreateEnum
CREATE TYPE "OnChainStatus" AS ENUM ('Scheduled', 'Delayed', 'Cancelled', 'Landed');

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('oracle_update', 'keeper_check');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'submitted', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "tracked_flight" (
    "id" TEXT NOT NULL,
    "flight_id" TEXT NOT NULL,
    "flight_iata" TEXT NOT NULL,
    "flight_date" TEXT NOT NULL,
    "origin_iata" TEXT NOT NULL,
    "dest_iata" TEXT NOT NULL,
    "scheduled_departure_utc" TIMESTAMPTZ NOT NULL,
    "scheduled_arrival_utc" TIMESTAMPTZ,
    "last_submitted_status" "OnChainStatus" NOT NULL DEFAULT 'Scheduled',
    "last_submitted_delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "last_submitted_at" TIMESTAMPTZ,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "keeper_eligible_after" TIMESTAMPTZ,
    "keeper_last_called_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tracked_flight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tx_outbox" (
    "id" TEXT NOT NULL,
    "flight_id" TEXT NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "intended_status" "OnChainStatus",
    "intended_delay_minutes" INTEGER,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "tx_hash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "submitted_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tx_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_cursor" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_processed_block" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "indexer_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_flight_flight_id_key" ON "tracked_flight"("flight_id");

-- CreateIndex
CREATE INDEX "tracked_flight_is_terminal_idx" ON "tracked_flight"("is_terminal");

-- CreateIndex
CREATE INDEX "tracked_flight_scheduled_departure_utc_idx" ON "tracked_flight"("scheduled_departure_utc");

-- CreateIndex
CREATE INDEX "tracked_flight_keeper_eligible_after_idx" ON "tracked_flight"("keeper_eligible_after");

-- CreateIndex
CREATE INDEX "tx_outbox_status_idx" ON "tx_outbox"("status");

-- CreateIndex
CREATE INDEX "tx_outbox_flight_id_kind_status_idx" ON "tx_outbox"("flight_id", "kind", "status");

-- AddForeignKey
ALTER TABLE "tx_outbox" ADD CONSTRAINT "tx_outbox_flight_id_fkey" FOREIGN KEY ("flight_id") REFERENCES "tracked_flight"("flight_id") ON DELETE RESTRICT ON UPDATE CASCADE;

