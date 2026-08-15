interface ImportMetaEnv {
  readonly PUBLIC_REPO_APPS_FAKE?: string;
  readonly PUBLIC_REPO_OWNER?: string;
  readonly PUBLIC_REPO_NAME?: string;
  readonly PUBLIC_REPO_BRANCH?: string;
  readonly PUBLIC_REPO_DATA_PATH?: string;
  readonly PUBLIC_APP_VERSION?: string;
  readonly PUBLIC_COMMIT_SHA?: string;
  readonly PUBLIC_GITHUB_DEVICE_CLIENT_ID?: string;
  readonly PUBLIC_GITHUB_DEVICE_SCOPE?: "public_repo" | "repo";
  readonly PUBLIC_TODO_PLUGIN_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
