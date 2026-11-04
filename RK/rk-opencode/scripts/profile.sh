#!/usr/bin/env bash
# JSON strings are shell-quoted by the shared Python loader.
_rk_profile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_rk_profile_values="$(python3 "$_rk_profile_root/model_profiles.py" shell)" || return $?
eval "$_rk_profile_values"
export RK_AGENT_PROFILE
unset _rk_profile_root _rk_profile_values
