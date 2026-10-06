module.exports = {
  apps: [{
    name: "whatyousay",
    script: "./start.sh",
    cwd: __dirname,
    interpreter: "bash",
    restart_delay: 5000,
    max_restarts: 10,
    // Above DRAIN_TIMEOUT_MS (src/shutdown.ts): pm2's default 1.6 s killed in-flight voice notes.
    kill_timeout: 60000,
  }]
}
