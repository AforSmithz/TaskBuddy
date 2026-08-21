#!/usr/bin/env bash
# The list of schema files, and how to hash one. Sourced by BOTH apply-sql.sh
# (which applies them and records the hashes) and check-schema.sh (which
# recomputes the hashes and compares). One definition, so the applier and the
# gate cannot disagree about what the schema is.
#
# Source it with aws/ as the working directory.

# Applied in lexicographic order, which is what the numeric prefixes encode and
# what the ordering notes in the files themselves assume (02 before 03, 01
# before 06). A new NN_*.sql file is picked up automatically and is therefore
# required by the gate from the moment it lands - that is the intent.
#
# NEVER_APPLIED is the one exception, and it is not a convenience: 05 drops
# users.password_hash, which is destructive and irreversible, and must happen
# deliberately once every legacy account has signed in. Auto-running it during a
# cutover is precisely the accident this list prevents. A file named here is
# excluded from the run AND from the gate, so the gate can never demand a file
# that must not be applied.
NEVER_APPLIED=("05_drop_password_hash.sql")

schema_files() {
  local f base
  for f in sql/[0-9][0-9]_*.sql; do
    base=$(basename "$f")
    local skip=""
    for n in "${NEVER_APPLIED[@]}"; do
      [ "$base" = "$n" ] && skip=1
    done
    [ -n "$skip" ] || echo "$base"
  done
}

# sha256 of one file's contents, bare hex. Two implementations because the
# applier runs on a mac laptop and the gate runs on an ubuntu runner, and the
# two ship different tools under different names. Same bytes in, same hex out.
sql_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
