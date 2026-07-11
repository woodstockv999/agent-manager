#!/usr/bin/env bash
# 一度きりのバックフィル: Claude Code のセッション記録(transcripts)から
# 過去の Skill ツール呼び出し(skill, timestamp)を全て抽出し executions.jsonl を生成する。
#
# ・~/.claude/projects/ 配下の全 *.jsonl を再帰探索(サブエージェント記録も含む)
# ・grep で '"Skill"' を含む行だけに絞ってから jq に渡す(高速化)
# ・プラグイン名前空間は hook と同じく除去 (foo@plugin-ns -> foo)
# ・ts で昇順ソートして出力
#
# 出力行フォーマット: {"id":"<skill>","ts":"<ISO8601>"}
set -euo pipefail

PROJECTS_DIR="${HOME}/.claude/projects"
OUT="$(cd "$(dirname "$0")/.." && pwd)/executions.jsonl"
TMP="$(mktemp)"

echo "スキャン中: ${PROJECTS_DIR}"

# 全 transcript を再帰的に探索し、Skill を含む行だけ jq へ
find "${PROJECTS_DIR}" -type f -name '*.jsonl' -print0 \
  | xargs -0 grep -h '"Skill"' 2>/dev/null \
  | jq -r '
      select(.type=="assistant")
      | .timestamp as $ts
      | (.message.content // [])[]?
      | select(type=="object" and .type=="tool_use" and .name=="Skill")
      | (.input.skill // empty) as $s
      | select($s != "")
      | select($ts != null)
      | "\($ts)\t{\"id\":\(($s | split("@")[0]) | @json),\"ts\":\($ts | @json)}"
    ' \
  | sort \
  | cut -f2- \
  > "${TMP}"

mv "${TMP}" "${OUT}"

TOTAL=$(wc -l < "${OUT}")
echo "書き出し: ${OUT}"
echo "イベント総数: ${TOTAL}"
echo "期間: $(head -1 "${OUT}" | jq -r .ts) 〜 $(tail -1 "${OUT}" | jq -r .ts)"
echo "--- 上位スキル ---"
jq -r .id "${OUT}" | sort | uniq -c | sort -rn | head -20
