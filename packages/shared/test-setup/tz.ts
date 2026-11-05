// Pin all shared-package tests to Europe/Vilnius so DST and date-of-week
// assertions are TZ-deterministic. Without this, CI on UTC runners would
// silently degrade DST tests to smoke tests.
process.env.TZ = "Europe/Vilnius";
