import { defineCommand } from "citty";
import { greet } from "../../core/index.ts";

export default defineCommand({
  meta: {
    name: "hello",
    description: "Print a greeting",
  },
  args: {
    name: {
      type: "string",
      description: "Name to greet",
    },
  },
  run({ args }) {
    console.log(greet({ name: args.name }));
  },
});
