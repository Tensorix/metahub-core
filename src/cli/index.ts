import { defineCommand, runMain } from "citty";
import pkg from "../../package.json" with { type: "json" };
import hello from "./commands/hello.ts";

const main = defineCommand({
  meta: {
    name: "metahub",
    version: pkg.version,
    description: pkg.description ?? "",
  },
  subCommands: {
    hello,
  },
});

runMain(main);
