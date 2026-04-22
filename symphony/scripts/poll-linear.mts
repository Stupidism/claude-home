#!/usr/bin/env node --experimental-strip-types
/**
 * poll-linear.mts — Back-compat shim.
 *
 * The real poller lives in `poll-tickets.mts` now that it supports both Linear
 * and Jira. Old launcher scripts and aliases that still reference
 * `poll-linear.mts` keep working because this file just re-exports it. The
 * singleton pgrep in `poll-tickets.mts` matches both filenames, so nothing
 * racing is introduced.
 */

import './poll-tickets.mts';
