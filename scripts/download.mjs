#!/usr/bin/env node

import process from "node:process";

import { runCli } from "./pipeline/run-batch.js";

runCli(process.argv.slice(2))
  .then(({ exitCode }) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
