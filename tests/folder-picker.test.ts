import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSubfolderInParent,
  validateSubfolderName
} from "../src/projects/folder-picker.js";

describe("Folder Picker & Subfolder Security", () => {
  it("valida nomes seguros de subpasta e bloqueia traversal/segredos/reservados", () => {
    assert.equal(validateSubfolderName("LedgerPulse").valid, true);
    assert.equal(validateSubfolderName("meu-app_v2.0").valid, true);
    assert.equal(validateSubfolderName("Projeto 2026").valid, true);

    assert.equal(validateSubfolderName("").valid, false);
    assert.equal(validateSubfolderName("..").valid, false);
    assert.equal(validateSubfolderName("../fora").valid, false);
    assert.equal(validateSubfolderName("sub/dir").valid, false);
    assert.equal(validateSubfolderName("sub\\dir").valid, false);
    assert.equal(validateSubfolderName(".git").valid, false);
    assert.equal(validateSubfolderName(".env").valid, false);
    assert.equal(validateSubfolderName(".env.local").valid, false);
    assert.equal(validateSubfolderName("node_modules").valid, false);
    assert.equal(validateSubfolderName("CON").valid, false);
    assert.equal(validateSubfolderName("nul.txt").valid, false);
    assert.equal(validateSubfolderName("a".repeat(65)).valid, false);
  });

  it("cria subpasta dentro de diretório válido e reutiliza se já existir", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "aic-folder-picker-"));
    try {
      const first = await createSubfolderInParent(baseDir, "meu-app-teste");
      assert.equal(first.created, true);
      assert.equal(first.alreadyExisted, false);
      assert.equal(first.inspection.valid, true);
      const info = await stat(first.path);
      assert.equal(info.isDirectory(), true);

      const second = await createSubfolderInParent(baseDir, "meu-app-teste");
      assert.equal(second.created, false);
      assert.equal(second.alreadyExisted, true);
      assert.equal(second.path, first.path);

      await assert.rejects(
        () => createSubfolderInParent(baseDir, "../escapar"),
        /inválido|segurança/i
      );
      await assert.rejects(
        () => createSubfolderInParent(baseDir, ".git"),
        /letras|reservado|bloqueado|inválido/i
      );
      await assert.rejects(
        () => createSubfolderInParent(baseDir, "node_modules"),
        /reservado|bloqueado/i
      );
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
