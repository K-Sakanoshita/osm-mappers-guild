#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

test_dir=$(mktemp -d)
cleanup() {
    if [[ -n ${server_pid:-} ]]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
    fi
    rm -rf -- "$test_dir"
}
trap cleanup EXIT

mkdir -p "$test_dir/www/api" "$test_dir/sessions"
cp api/index.php "$test_dir/www/api/"
cat > "$test_dir/www/api/config.php" <<'PHP'
<?php
return [
    // 旧設定が残っていても開発用ログインは無効であることを確認する。
    'app_env' => 'dev',
    'db_dsn' => 'sqlite:' . dirname(__DIR__, 2) . '/guild.sqlite',
    'db_user' => '',
    'db_pass' => '',
    'cookie_samesite' => 'Lax',
];
PHP

: > "$test_dir/server.log"
php -d "session.save_path=$test_dir/sessions" -S 127.0.0.1:8099 -t "$test_dir/www" > "$test_dir/server.log" 2>&1 &
server_pid=$!
for ((attempt = 0; attempt < 50; attempt++)); do
    if [[ $(<"$test_dir/server.log") == *"Development Server "*" started"* ]]; then
        break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
        break
    fi
    sleep 0.1
done
if [[ $(<"$test_dir/server.log") != *"Development Server "*" started"* ]] || ! python3 tests/smoke_test.py "$test_dir"; then
    cat "$test_dir/server.log" >&2
    exit 1
fi
