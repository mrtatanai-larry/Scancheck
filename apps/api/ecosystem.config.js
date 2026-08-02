module.exports = {
    apps: [
        {
            name: 'scancheck-server',
            cwd: __dirname,
            script: 'server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            max_memory_restart: '600M',
            listen_timeout: 10000,
            kill_timeout: 12000,
            env: {
                NODE_ENV: 'production',
                SCANCHECK_PORT: 3000
            },
            error_file: '/tmp/scancheck-pm2-error.log',
            out_file: '/tmp/scancheck-pm2-out.log',
            merge_logs: true
        }
    ]
};
