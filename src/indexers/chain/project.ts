import { Address, ScriptHash } from "lucid-cardano";

import { deconstructAddress } from "@teiki/protocol/helpers/schema";
import * as S from "@teiki/protocol/schema";
import {
  ProjectDatum,
  ProjectDetailDatum,
  ProjectScriptDatum,
  ProjectStatus,
} from "@teiki/protocol/schema/teiki/project";
import { Cid, Hex, UnixTime } from "@teiki/protocol/types";

import { $handlers } from "../../framework/chain";
import { prettyOutRef } from "../../framework/chain/conversions";
import { Lovelace } from "../../types/chain";
import { NonEmpty } from "../../types/typelevel";

import { TeikiChainIndexContext } from "./context";

const ProjectStatusMapping = {
  Active: "active",
  PreClosed: "pre-closed",
  PreDelisted: "pre-delisted",
  Closed: "closed",
  Delisted: "delisted",
} as const satisfies { [K in ProjectStatus["type"]]: string };

export type ProjectStatusLiteral =
  (typeof ProjectStatusMapping)[keyof typeof ProjectStatusMapping];

export type ChainProject = {
  projectId: Hex;
  ownerAddress: Address;
  status: ProjectStatusLiteral;
  statusTime: UnixTime | null;
  milestoneReached: number;
  isStakingDelegationManagedByProtocol: boolean;
};

export type ChainProjectDetail = {
  projectId: Hex;
  withdrawnFunds: Lovelace;
  sponsorshipAmount: Lovelace | null;
  sponsorshipUntil: UnixTime | null;
  informationCid: Cid;
  lastAnnouncementCid: Cid | null;
};

export type ChainProjectScript = {
  projectId: Hex;
  stakingKeyDeposit: Lovelace;
  stakingScriptHash: ScriptHash;
};

export type Event =
  | { type: "project"; indicies: NonEmpty<number[]> }
  | { type: "project_detail"; indicies: NonEmpty<number[]> }
  | { type: "project_script"; indicies: NonEmpty<number[]> }
  | { type: "project_script$ceased" };
const $ = $handlers<TeikiChainIndexContext, Event>();

export const setup = $.setup(async ({ sql }) => {
  await sql`
    DO $$ BEGIN
      IF to_regtype('chain.project_status') IS NULL THEN
        CREATE TYPE chain.project_status AS ENUM (${sql.unsafe(
          Object.values(ProjectStatusMapping)
            .map((e) => `'${e}'`)
            .join(", ")
        )});
      END IF;
    END $$
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS chain.project (
      id bigint PRIMARY KEY REFERENCES chain.output (id) ON DELETE CASCADE,
      project_id varchar(64) NOT NULL,
      owner_address text NOT NULL,
      status chain.project_status NOT NULL,
      status_time timestamptz,
      milestone_reached smallint NOT NULL,
      is_staking_delegation_managed_by_protocol boolean NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS project_pid_index
      ON chain.project(project_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS project_status_index
      ON chain.project(status)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chain.project_detail (
      id bigint PRIMARY KEY REFERENCES chain.output (id) ON DELETE CASCADE,
      project_id varchar(64) NOT NULL,
      withdrawn_funds bigint NOT NULL,
      sponsorship_amount bigint,
      sponsorship_until timestamptz,
      information_cid text NOT NULL,
      last_announcement_cid text
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS project_detail_pid_index
      ON chain.project_detail(project_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS project_detail_information_cid_index
      ON chain.project_detail(information_cid)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS chain.project_script (
      id bigint PRIMARY KEY REFERENCES chain.output (id) ON DELETE CASCADE,
      project_id varchar(64) NOT NULL,
      staking_key_deposit bigint NOT NULL,
      staking_script_hash varchar(56) NOT NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS project_script_pid_index
      ON chain.project_script(project_id)
  `;
});

export const filter = $.filter(
  ({
    tx,
    context: {
      config: {
        authsProject: { project, projectDetail, projectScript },
      },
    },
  }) => {
    const projectIndicies: number[] = [];
    const projectDetailIndicies: number[] = [];
    const projectScriptIndicies: number[] = [];
    for (const [index, output] of tx.body.outputs.entries()) {
      const assets = output.value.assets;
      if (assets == null) continue;
      const isIn = (a: string) => assets[a] === 1n;
      // TODO: Integrity validation: An output should not contain
      // more than one type of the three tokens below
      if (project.some(isIn)) projectIndicies.push(index);
      else if (projectDetail.some(isIn)) projectDetailIndicies.push(index);
      else if (projectScript.some(isIn)) projectScriptIndicies.push(index);
    }
    const events: Event[] = [];
    if (projectIndicies.length)
      events.push({ type: "project", indicies: projectIndicies });
    if (projectDetailIndicies.length)
      events.push({ type: "project_detail", indicies: projectDetailIndicies });
    if (projectScriptIndicies.length)
      events.push({ type: "project_script", indicies: projectScriptIndicies });
    const minted = tx.body.mint.assets;
    if (minted && projectScript.some((a) => (minted[a] ?? 0) < 0))
      events.push({ type: "project_script$ceased" });
    return events;
  }
);

export const projectEvent = $.event<"project">(
  async ({ driver, connections: { sql, lucid }, event: { indicies } }) => {
    const projects = await driver.store(indicies, (output) => {
      if (output.datum == null) {
        console.warn(
          "datum should be available for project",
          prettyOutRef(output)
        );
        return undefined;
      }
      const projectDatum = S.fromData(S.fromCbor(output.datum), ProjectDatum);
      const projectId = projectDatum.projectId.id;
      const status = projectDatum.status;
      const statusTime =
        "pendingUntil" in status
          ? status.pendingUntil
          : "closedAt" in status
          ? status.closedAt
          : "delistedAt" in status
          ? status.delistedAt
          : null;

      return [
        `project:${projectId}`,
        {
          projectId,
          status: ProjectStatusMapping[status.type],
          statusTime: statusTime ? Number(statusTime.timestamp) : null,
          ownerAddress: deconstructAddress(lucid, projectDatum.ownerAddress),
          milestoneReached: Number(projectDatum.milestoneReached),
          isStakingDelegationManagedByProtocol:
            projectDatum.isStakingDelegationManagedByProtocol,
        },
      ];
    });
    if (!projects.length) {
      console.warn("there is no valid project");
      return;
    }
    driver.refresh("views.project_summary");
    await sql`INSERT INTO chain.project ${sql(projects)}`;
  }
);

export const projectDetailEvent = $.event<"project_detail">(
  async ({ driver, connections: { sql }, event: { indicies } }) => {
    let hasAnnouncement = false;
    const projectDetails = await driver.store(indicies, (output) => {
      if (output.datum == null) {
        console.warn(
          "datum should be available for project detail",
          prettyOutRef(output)
        );
        return undefined;
      }
      const projectDetailDatum = S.fromData(
        S.fromCbor(output.datum),
        ProjectDetailDatum
      );
      const projectId = projectDetailDatum.projectId.id;
      const datSponsorship = projectDetailDatum.sponsorship;
      const sponsorship = datSponsorship
        ? {
            sponsorshipAmount: datSponsorship.amount,
            sponsorshipUntil: Number(datSponsorship.until.timestamp),
          }
        : {
            sponsorshipAmount: null,
            sponsorshipUntil: null,
          };
      if (projectDetailDatum.lastAnnouncementCid) hasAnnouncement = true;
      return [
        `project-detail:${projectId}`,
        {
          projectId,
          withdrawnFunds: projectDetailDatum.withdrawnFunds,
          informationCid: projectDetailDatum.informationCid.cid,
          lastAnnouncementCid:
            projectDetailDatum.lastAnnouncementCid?.cid ?? null,
          ...sponsorship,
        },
      ];
    });
    if (!projectDetails.length) {
      console.warn("there is no valid project detail");
      return;
    }
    await sql`INSERT INTO chain.project_detail ${sql(projectDetails)}`;
    driver.notify("ipfs.project_info");
    hasAnnouncement && driver.notify("ipfs.project_announcement");
    driver.refresh("views.project_summary");
  }
);

export const projectScriptEvent = $.event<"project_script">(
  async ({
    driver,
    context: { staking },
    connections: { sql },
    event: { indicies },
  }) => {
    const projectScripts = await driver.storeWithScript(indicies, (output) => {
      if (output.scriptHash == null) {
        console.warn(
          "script reference should be available for project script",
          prettyOutRef(output)
        );
        return undefined;
      }
      if (output.datum == null) {
        console.warn(
          "datum should be available for project script",
          prettyOutRef(output)
        );
        return undefined;
      }
      const projectScriptDatum = S.fromData(
        S.fromCbor(output.datum),
        ProjectScriptDatum
      );
      const projectId = projectScriptDatum.projectId.id;
      return [
        `project-script:${projectId}`,
        {
          projectId,
          stakingKeyDeposit: projectScriptDatum.stakingKeyDeposit,
          stakingScriptHash: output.scriptHash,
        },
      ];
    });
    if (!projectScripts.length) {
      console.warn("there is no valid project script");
      return;
    }
    for (const { stakingScriptHash } of projectScripts)
      staking.watch(stakingScriptHash, "Script");
    await sql`INSERT INTO chain.project_script ${sql(projectScripts)}`;
  }
);
