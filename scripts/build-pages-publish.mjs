import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, ".pages-build");

const rootFiles = [
  "index.html",
  "edit.html",
  "documents.html",
  "styles.css",
  "structure.yaml",
];

const rootDirs = [
  "js",
];

const dataDirs = [
  path.join("data", "people"),
  path.join("data", "text_processing"),
];

const textDocumentsDir = path.join("data", "sources", "text_documents");

function resetOutputDir() {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
}

function copyFile(relativePath) {
  const source = path.join(rootDir, relativePath);
  const target = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDir(relativePath) {
  const source = path.join(rootDir, relativePath);
  const target = path.join(outputDir, relativePath);
  fs.cpSync(source, target, { recursive: true });
}

resetOutputDir();

for (const fileName of rootFiles) {
  copyFile(fileName);
}

for (const dirName of rootDirs) {
  copyDir(dirName);
}

for (const dirName of dataDirs) {
  copyDir(dirName);
}

if (fs.existsSync(path.join(rootDir, textDocumentsDir))) {
  copyDir(textDocumentsDir);
}

console.log(`Pages publish directory ready: ${outputDir}`);
