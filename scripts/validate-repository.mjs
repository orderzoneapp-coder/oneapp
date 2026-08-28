#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const failures = [];
const warnings = [];
const checks = [];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function recordCheck(message) {
  checks.push(message);
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function resolveRepositoryPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    fail("Repository path must be a non-empty string.");
    return null;
  }

  const resolved = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

  if (resolved !== ROOT && !resolved.startsWith(rootPrefix)) {
    fail("Repository path escapes the checkout: " + relativePath);
    return null;
  }

  return resolved;
}

function repositoryFileExists(relativePath) {
  const resolved = resolveRepositoryPath(relativePath);
  return Boolean(resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile());
}

function readRepositoryFile(relativePath) {
  const resolved = resolveRepositoryPath(relativePath);
  if (!resolved || !fs.existsSync(resolved)) {
    fail("Required file is missing: " + relativePath);
    return null;
  }

  return fs.readFileSync(resolved, "utf8");
}

function requireFields(item, fields, label) {
  for (const field of fields) {
    if (!hasOwn(item, field)) {
      fail(label + " is missing required field: " + field);
      continue;
    }

    if (typeof item[field] === "string" && item[field].trim() === "") {
      fail(label + " has an empty required field: " + field);
    }
  }
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}

function countMatches(text, expression) {
  return (text.match(expression) || []).length;
}

function validateHtml(relativePath, label, strict) {
  const html = readRepositoryFile(relativePath);
  if (html === null) {
    return;
  }

  if (html.trim().length < 100) {
    fail(label + " is unexpectedly small: " + relativePath);
  }

  if (html.includes("\0")) {
    fail(label + " contains a null byte: " + relativePath);
  }

  if (/^(<{7}|={7}|>{7})/m.test(html)) {
    fail(label + " contains an unresolved merge-conflict marker: " + relativePath);
  }

  const openingBody = countMatches(html, /<body\b/gi);
  const closingBody = countMatches(html, /<\/body\s*>/gi);
  const openingHtml = countMatches(html, /<html\b/gi);
  const closingHtml = countMatches(html, /<\/html\s*>/gi);

  if (strict && (openingBody === 0 || closingBody === 0)) {
    fail(label + " must include opening and closing body tags: " + relativePath);
  }

  if (openingBody !== closingBody) {
    fail(label + " has unbalanced body tags: " + relativePath);
  }

  if (openingHtml !== closingHtml) {
    fail(label + " has unbalanced html tags: " + relativePath);
  }

  if (!/<!doctype\s+html/i.test(html)) {
    warn(label + " does not declare an HTML doctype: " + relativePath);
  }

  recordCheck("HTML structure: " + relativePath);
}

function validateJavaScriptSyntax(relativePath) {
  const source = readRepositoryFile(relativePath);
  if (source === null) {
    return;
  }

  try {
    new vm.Script(source, { filename: relativePath });
    recordCheck("JavaScript syntax: " + relativePath);
  } catch (error) {
    fail(relativePath + " has invalid JavaScript syntax: " + error.message);
  }
}

function writeStepSummary() {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  const lines = [
    "## ONEAPP repository validation",
    "",
    "- Checks completed: " + checks.length,
    "- Warnings: " + warnings.length,
    "- Failures: " + failures.length,
    "",
  ];

  if (failures.length > 0) {
    lines.push("### Failures", "", ...failures.map((message) => "- " + message), "");
  }

  if (warnings.length > 0) {
    lines.push("### Warnings", "", ...warnings.map((message) => "- " + message), "");
  }

  fs.appendFileSync(summaryPath, lines.join("\n"), "utf8");
}

function finish() {
  for (const message of warnings) {
    console.warn("WARNING: " + message);
  }

  if (failures.length > 0) {
    console.error("Repository validation failed with " + failures.length + " error(s):");
    for (const message of failures) {
      console.error("- " + message);
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Repository validation passed (" +
        checks.length +
        " checks, " +
        warnings.length +
        " warning(s)).",
    );
  }

  writeStepSummary();
}

function main() {
  const manifestText = readRepositoryFile("app-manifest.json");
  if (manifestText === null) {
    finish();
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
    recordCheck("JSON syntax: app-manifest.json");
  } catch (error) {
    fail("app-manifest.json is not valid JSON: " + error.message);
    finish();
    return;
  }

  requireFields(
    manifest,
    [
      "schemaVersion",
      "repository",
      "statusDefinitions",
      "applications",
      "sharedDataContracts",
      "planningPolicy",
      "plannedApplications",
      "recoveryPolicy",
    ],
    "Manifest",
  );

  const applications = Array.isArray(manifest.applications) ? manifest.applications : [];
  const contracts = Array.isArray(manifest.sharedDataContracts)
    ? manifest.sharedDataContracts
    : [];
  const plannedApplications = Array.isArray(manifest.plannedApplications)
    ? manifest.plannedApplications
    : [];
  const statusDefinitions =
    manifest.statusDefinitions && typeof manifest.statusDefinitions === "object"
      ? manifest.statusDefinitions
      : {};

  if (applications.length === 0) {
    fail("Manifest must register at least one production application.");
  }

  const applicationIds = applications.map((application) => application.id);
  const applicationPaths = applications.map((application) => application.path);
  const duplicateApplicationIds = findDuplicates(applicationIds);
  const duplicateApplicationPaths = findDuplicates(applicationPaths);

  for (const duplicate of duplicateApplicationIds) {
    fail("Duplicate application id: " + duplicate);
  }
  for (const duplicate of duplicateApplicationPaths) {
    fail("Duplicate application path: " + duplicate);
  }

  const applicationIdSet = new Set(applicationIds);
  const contractIds = contracts.map((contract) => contract.id);
  const contractIdSet = new Set(contractIds);

  for (const duplicate of findDuplicates(contractIds)) {
    fail("Duplicate shared-data-contract id: " + duplicate);
  }

  for (const contract of contracts) {
    const label = "Shared contract " + String(contract.id || "<unknown>");
    requireFields(contract, ["id", "owner", "resources"], label);
    if (contract.owner && !applicationIdSet.has(contract.owner)) {
      fail(label + " has an unknown owner: " + contract.owner);
    }
  }

  const dependencyFields = ["navigatesTo", "runtimeDependencies", "services"];

  for (const application of applications) {
    const label = "Application " + String(application.id || "<unknown>");
    requireFields(application, ["id", "name", "path", "kind", "status", "purpose"], label);

    if (!hasOwn(statusDefinitions, application.status)) {
      fail(label + " uses an undefined status: " + application.status);
    }

    if (!repositoryFileExists(application.path)) {
      fail(label + " points to a missing file: " + application.path);
    }

    if (application.kind === "web-entry" && path.extname(application.path).toLowerCase() !== ".html") {
      fail(label + " is a web entry but does not use an .html path.");
    }

    if (Array.isArray(application.sharedContracts)) {
      for (const contractId of application.sharedContracts) {
        if (!contractIdSet.has(contractId)) {
          fail(label + " references an unknown shared contract: " + contractId);
        }
      }
    }

    for (const field of dependencyFields) {
      if (!hasOwn(application, field)) {
        continue;
      }
      if (!Array.isArray(application[field])) {
        fail(label + " field " + field + " must be an array.");
        continue;
      }
      for (const dependencyId of application[field]) {
        if (!applicationIdSet.has(dependencyId)) {
          fail(label + " field " + field + " references an unknown production application: " + dependencyId);
        }
      }
    }

    if (application.kind === "web-entry" && repositoryFileExists(application.path)) {
      validateHtml(application.path, label, true);
    }
  }

  const navigationEdges = Array.isArray(manifest.navigationEdges)
    ? manifest.navigationEdges
    : [];

  for (const edge of navigationEdges) {
    if (!Array.isArray(edge) || edge.length !== 2) {
      fail("Each navigation edge must be a two-item array.");
      continue;
    }

    if (!applicationIdSet.has(edge[0]) || !applicationIdSet.has(edge[1])) {
      fail("Navigation edge references an unknown production application: " + edge.join(" -> "));
    }
  }

  const requiredPlanningFields = Array.isArray(manifest.planningPolicy?.requiredFields)
    ? manifest.planningPolicy.requiredFields
    : [];
  const plannedIds = plannedApplications.map((application) => application.id);
  const plannedPaths = plannedApplications.map((application) => application.proposedPath);

  for (const duplicate of findDuplicates([...applicationIds, ...plannedIds])) {
    fail("Application id is duplicated across production and planned registries: " + duplicate);
  }

  for (const duplicate of findDuplicates([...applicationPaths, ...plannedPaths])) {
    fail("Application path is duplicated across production and planned registries: " + duplicate);
  }

  for (const plannedApplication of plannedApplications) {
    const label = "Planned application " + String(plannedApplication.id || "<unknown>");
    requireFields(plannedApplication, requiredPlanningFields, label);

    if (plannedApplication.status !== "planned") {
      fail(label + " must keep status=planned until promotion review.");
    }

    if (plannedApplication.productionWrites !== false) {
      fail(label + " must explicitly set productionWrites=false.");
    }

    if (Array.isArray(plannedApplication.sharedContracts)) {
      for (const contractId of plannedApplication.sharedContracts) {
        if (!contractIdSet.has(contractId)) {
          fail(label + " references an unknown shared contract: " + contractId);
        }
      }
    }

    if (repositoryFileExists(plannedApplication.proposedPath)) {
      validateHtml(plannedApplication.proposedPath, label, false);
    } else {
      warn(label + " proposed file is not present yet: " + plannedApplication.proposedPath);
    }
  }

  if (manifest.planningPolicy?.allowedProductionDependency !== false) {
    fail("planningPolicy.allowedProductionDependency must remain false.");
  }

  if (manifest.recoveryPolicy?.testCopiesAreBackups !== false) {
    fail("recoveryPolicy.testCopiesAreBackups must remain false.");
  }

  if (manifest.functionKeyPolicy) {
    if (manifest.functionKeyPolicy.applicationOwned !== true) {
      fail("functionKeyPolicy.applicationOwned must be true.");
    }
    if (manifest.functionKeyPolicy.crossApplicationSemanticUnification !== false) {
      fail("functionKeyPolicy.crossApplicationSemanticUnification must be false.");
    }

    const assignments = manifest.functionKeyPolicy.assignments;
    if (!assignments || typeof assignments !== "object") {
      fail("functionKeyPolicy.assignments must be an object.");
    } else {
      for (const [applicationId, shortcuts] of Object.entries(assignments)) {
        if (!applicationIdSet.has(applicationId)) {
          fail("Function-key assignments reference an unknown application: " + applicationId);
          continue;
        }
        if (!shortcuts || typeof shortcuts !== "object") {
          fail("Function-key assignments for " + applicationId + " must be an object.");
          continue;
        }
        for (const [key, description] of Object.entries(shortcuts)) {
          if (!/^F(?:[1-9]|1[0-2])$/.test(key)) {
            fail("Invalid function-key name for " + applicationId + ": " + key);
          }
          if (typeof description !== "string" || description.trim() === "") {
            fail("Function-key description is empty for " + applicationId + " " + key);
          }
        }
      }
    }
  }

  const roadmap = Array.isArray(manifest.developmentRoadmap)
    ? manifest.developmentRoadmap
    : [];
  const roadmapPhases = roadmap.map((item) => item.phase);
  for (const duplicate of findDuplicates(roadmapPhases)) {
    fail("Duplicate development-roadmap phase: " + duplicate);
  }
  if (roadmap.length > 0 && !roadmapPhases.includes(1)) {
    fail("Development roadmap must retain phase 1.");
  }

  const architecturePath = manifest.repository?.architectureDocument;
  if (!repositoryFileExists(architecturePath)) {
    fail("Architecture document is missing: " + String(architecturePath));
  } else {
    const architecture = readRepositoryFile(architecturePath);
    for (const applicationPath of [...applicationPaths, ...plannedPaths]) {
      if (!architecture.includes(applicationPath)) {
        fail("Architecture document does not mention registered path: " + applicationPath);
      }
    }
    recordCheck("Architecture registry coverage");
  }

  for (const relativePath of ["coreEngine.js", "code.gs"]) {
    if (repositoryFileExists(relativePath)) {
      validateJavaScriptSyntax(relativePath);
    }
  }

  const recoveryCopyPattern = /(?:_test|_backup|_copy)\.(?:html|js|gs)$/i;
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && recoveryCopyPattern.test(entry.name)) {
      warn("Root-level recovery copy is present; Git history should be the recovery source: " + entry.name);
    }
  }

  recordCheck("Application and dependency registry");
  recordCheck("Shared data contracts");
  recordCheck("Planned-application isolation");
  recordCheck("Function-key ownership policy");
  finish();
}

main();

