import type { FastifyRequest, FastifyReply } from "fastify";
import { buildInfo } from "../generated/buildInfo.js";

export async function getVersion(_request: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "public, max-age=60");
  return buildInfo;
}
