-- Quick Count v3 — initial schema migration
-- Drop old tables if they exist (handles migration from v2)

DROP TABLE IF EXISTS "StationAgent" CASCADE;
DROP TABLE IF EXISTS "PollingStation" CASCADE;
DROP TABLE IF EXISTS "Region" CASCADE;
DROP TABLE IF EXISTS "EvidenceRecord" CASCADE;
DROP TABLE IF EXISTS "Dispute" CASCADE;
DROP TABLE IF EXISTS "OrgMember" CASCADE;
DROP TABLE IF EXISTS "CachedSubmission" CASCADE;
DROP TABLE IF EXISTS "Candidate" CASCADE;
DROP TABLE IF EXISTS "Station" CASCADE;
DROP TABLE IF EXISTS "Election" CASCADE;
DROP TABLE IF EXISTS "Organization" CASCADE;
DROP TABLE IF EXISTS "UserRole" CASCADE;
DROP TABLE IF EXISTS "IndexerState" CASCADE;

CREATE TABLE "Organization" (
  "id"           SERIAL NOT NULL,
  "txHash"       TEXT NOT NULL,
  "ownerPubkey"  TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT NOT NULL DEFAULT '',
  "status"       TEXT NOT NULL DEFAULT 'pending',
  "feeConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "registeredAt" TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_txHash_key" ON "Organization"("txHash");

CREATE TABLE "OrgMember" (
  "id"           SERIAL NOT NULL,
  "orgId"        INTEGER NOT NULL,
  "memberPubkey" TEXT NOT NULL,
  "grantTxHash"  TEXT NOT NULL,
  "grantedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrgMember_grantTxHash_key" ON "OrgMember"("grantTxHash");

CREATE TABLE "Election" (
  "id"          SERIAL NOT NULL,
  "txHash"      TEXT NOT NULL,
  "orgId"       INTEGER NOT NULL,
  "name"        TEXT NOT NULL,
  "visibility"  TEXT NOT NULL DEFAULT 'public',
  "aggregation" TEXT NOT NULL DEFAULT 'first_report',
  "status"      TEXT NOT NULL DEFAULT 'open',
  "closedAt"    TIMESTAMP(3),
  "manualTally" JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Election_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Election_txHash_key" ON "Election"("txHash");

CREATE TABLE "Candidate" (
  "id"           SERIAL NOT NULL,
  "txHash"       TEXT NOT NULL,
  "electionId"   INTEGER NOT NULL,
  "name"         TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Candidate_txHash_key" ON "Candidate"("txHash");

CREATE TABLE "Station" (
  "id"         SERIAL NOT NULL,
  "txHash"     TEXT NOT NULL,
  "electionId" INTEGER NOT NULL,
  "name"       TEXT NOT NULL,
  "region"     TEXT NOT NULL DEFAULT '',
  CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Station_txHash_key" ON "Station"("txHash");

CREATE TABLE "CachedSubmission" (
  "id"              SERIAL NOT NULL,
  "txHash"          TEXT NOT NULL,
  "stationId"       INTEGER NOT NULL,
  "electionId"      INTEGER NOT NULL,
  "submitterPubkey" TEXT NOT NULL,
  "votes"           JSONB NOT NULL,
  "totalVotes"      INTEGER,
  "invalidVotes"    INTEGER,
  "refTxHash"       TEXT,
  "blockHeight"     INTEGER NOT NULL DEFAULT 0,
  "chainTimestamp"  TIMESTAMP(3) NOT NULL,
  "indexedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"          TEXT NOT NULL DEFAULT 'ok',
  CONSTRAINT "CachedSubmission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CachedSubmission_txHash_key" ON "CachedSubmission"("txHash");

CREATE TABLE "EvidenceRecord" (
  "id"             SERIAL NOT NULL,
  "txHash"         TEXT NOT NULL,
  "submissionId"   INTEGER NOT NULL,
  "electionId"     INTEGER NOT NULL,
  "uploaderPubkey" TEXT NOT NULL,
  "sha256"         TEXT NOT NULL,
  "ipfsCid"        TEXT NOT NULL DEFAULT '',
  "ipfsStatus"     TEXT NOT NULL DEFAULT 'pending',
  "filePath"       TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvidenceRecord_txHash_key" ON "EvidenceRecord"("txHash");

CREATE TABLE "Dispute" (
  "id"            SERIAL NOT NULL,
  "txHash"        TEXT NOT NULL,
  "submissionId"  INTEGER NOT NULL,
  "electionId"    INTEGER NOT NULL,
  "filerPubkey"   TEXT NOT NULL,
  "reason"        TEXT NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',
  "resolvedAt"    TIMESTAMP(3),
  "resolvedBy"    TEXT NOT NULL DEFAULT '',
  "resolution"    TEXT NOT NULL DEFAULT '',
  "resolveTxHash" TEXT NOT NULL DEFAULT '',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Dispute_txHash_key" ON "Dispute"("txHash");

CREATE TABLE "UserRole" (
  "id"     SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "role"   TEXT NOT NULL,
  CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserRole_userId_key" ON "UserRole"("userId");

CREATE TABLE "IndexerState" (
  "id"               INTEGER NOT NULL DEFAULT 1,
  "lastIndexedBlock" INTEGER NOT NULL DEFAULT 0,
  "lastIndexedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Election" ADD CONSTRAINT "Election_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_electionId_fkey"
  FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Station" ADD CONSTRAINT "Station_electionId_fkey"
  FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CachedSubmission" ADD CONSTRAINT "CachedSubmission_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CachedSubmission" ADD CONSTRAINT "CachedSubmission_electionId_fkey"
  FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "CachedSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_electionId_fkey"
  FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "CachedSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_electionId_fkey"
  FOREIGN KEY ("electionId") REFERENCES "Election"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
