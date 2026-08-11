import { defineRepoApp } from "@repo-apps/runtime";

export default defineRepoApp({
  id: "quick-log",
  title: "Quick Log",
  repository: {
    mode: "self",
    branch: "main",
    dataRoot: "data"
  },
  auth: {
    methods: ["pat", "device-flow"],
    persistence: "optional",
    sharedCredential: true
  },
  demo: {
    fixture: "./demo/records.json"
  },
  writes: {
    defaultStrategy: "direct",
    conflictStrategy: "prompt"
  }
});
