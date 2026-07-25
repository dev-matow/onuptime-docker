/**
 * Imported first by seed/reset scripts: seeding must create accounts,
 * which DEMO_MODE deliberately blocks. Overriding before src/lib/env
 * parses lets the same command work on demo deployments.
 */
process.env.DEMO_MODE = "false";
