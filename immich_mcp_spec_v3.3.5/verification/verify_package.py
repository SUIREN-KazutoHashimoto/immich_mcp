#!/usr/bin/env python3
"""Verify specification inputs, not a future MCP application.

Uses only the Python standard library. The JSON Schema checks below verify
structure and local references; they are not a full JSON Schema metaschema
validator and do not execute an MCP server.
"""
from collections import Counter
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SHA = "632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9"
EXPECTED_COMMIT = "8303cb117e197c700332b33b61b45314c9cc5bb4"
METHODS = {"get", "put", "post", "delete", "patch", "head", "options", "trace"}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read_json(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def resolve(document, pointer):
    require(pointer.startswith("#/") or pointer == "#", "Nonlocal pointer: " + pointer)
    value = document
    if pointer == "#":
        return value
    for part in pointer[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def check_schema_structure(schema):
    require(schema.get("type") == "object", "Tool schema root must be object")
    for node in walk(schema):
        if not isinstance(node, dict):
            continue
        if "$ref" in node:
            resolve(schema, node["$ref"])
        if "pattern" in node and isinstance(node["pattern"], str):
            re.compile(node["pattern"])
        if "required" in node:
            require(isinstance(node["required"], list), "required must be array")
            require(len(set(node["required"])) == len(node["required"]), "Duplicate required")
            if "properties" in node:
                require(set(node["required"]) <= set(node["properties"]), "Undefined required field")


def main():
    verified_json_files = 0
    for file in sorted(ROOT.rglob("*.json")):
        json.loads(file.read_text(encoding="utf-8"))
        verified_json_files += 1

    raw = (ROOT / "api/immich-openapi-v3.3.5.json").read_bytes()
    require(hashlib.sha256(raw).hexdigest() == EXPECTED_SHA, "OpenAPI SHA mismatch")
    spec = json.loads(raw)
    require(spec["info"]["version"] == "3.3.5", "Version mismatch")
    triples = {
        (op["operationId"], method.upper(), path)
        for path, item in spec["paths"].items()
        for method, op in item.items()
        if method in METHODS
    }
    require(len(triples) == 279 and len(spec["paths"]) == 193, "Wrong API set size")
    ids = {operation for operation, _, _ in triples}
    require(len(ids) == 279, "Duplicate operationId")
    refs = [node["$ref"] for node in walk(spec) if isinstance(node, dict) and "$ref" in node]
    for pointer in refs:
        resolve(spec, pointer)

    inventory = read_json("api/operation-inventory.json")
    listed = {(op["operation_id"], op["http_method"], op["path"]) for op in inventory["operations"]}
    require(listed == triples, "Inventory set differs from OpenAPI")
    source = read_json("api/source-manifest.json")
    require(source["commit_sha"] == EXPECTED_COMMIT, "Commit mismatch")

    auth = read_json("contracts/auth-contexts.v3.3.5.json")
    require(len(auth["session_only_operations"]) == 7, "Wrong session exception count")
    require(len(auth["shared_link_only_operations"]) == 2, "Wrong shared-link exception count")
    require(len(auth["api_key_only_operations"]) == 1, "Wrong API-key exception count")
    require(len(auth["public_operations"]) == 17, "Wrong public count")
    require(len(auth["setup_only_operations"]) == 2, "Wrong setup count")
    for node in walk(auth):
        if isinstance(node, dict) and isinstance(node.get("operation_id"), str):
            require(node["operation_id"] in ids, "Unknown auth operation: " + node["operation_id"])
    require(auth["primary_api_call"]["fallback_to_session"] is False, "Session fallback changed")
    require(auth["primary_api_call"]["local_per_operation_permission_allowlist"] is False,
            "Local ACL introduced")
    require(auth["alternative_auth_modes"]["general_session_execution_and_locked_asset_support"]
            ["enabled_by_default"] is False, "General session default changed")

    overrides = read_json("contracts/operation-overrides.v3.3.5.json")
    override_ops = overrides["operation_overrides"]
    require(len({op["operation_id"] for op in override_ops}) == len(override_ops), "Duplicate override")
    for op in override_ops:
        require((op["operation_id"], op["http_method"], op["api_relative_path"]) in triples,
                "Override method/path mismatch: " + op["operation_id"])
        require(resolve(spec, op["openapi_operation_pointer"])["operationId"] == op["operation_id"],
                "Override pointer mismatch")
    secret_bindings = 0
    for rule in overrides["secret_field_rules"]:
        require(resolve(spec, rule["schema_property_pointer"]) == rule["field_type"],
                "Secret schema field mismatch: " + rule["rule_id"])
        for binding in rule["bindings"]:
            require(binding["operation_id"] in ids, "Unknown secret binding operation")
            secret_bindings += 1

    tools = read_json("contracts/mcp-tool-contracts.json")["tools"]
    require(len(tools) == len({tool["name"] for tool in tools}) == 9, "Wrong MCP tool set")
    for tool in tools:
        check_schema_structure(tool["inputSchema"])
        check_schema_structure(tool["outputSchema"])
    stage = next(tool for tool in tools if tool["name"] == "immich_stage_files")
    file_schema = stage["inputSchema"]["$defs"]["OpenAIFile"]
    require(set(file_schema["properties"]) == {"download_url", "file_id", "mime_type", "file_name"},
            "fileParams properties differ")
    require(set(file_schema["required"]) == {"download_url", "file_id"}, "fileParams required differs")
    require(stage["_meta"]["openai/fileParams"] == ["files"], "fileParams metadata differs")

    main_text = (ROOT / "Immich_MCP_v3.3.5_Specification.md").read_text(encoding="utf-8")
    headings = re.findall(r"^## ([0-9]+)\.", main_text, re.M)
    require(headings == [str(i) for i in range(1, 23)], "Main chapter sequence differs")
    require("searchMetadata" not in main_text, "Nonexistent searchMetadata operation")
    for tool in tools:
        require(tool["name"] in main_text, "Tool absent from main specification")

    tag_section = main_text.split("## 21. ", 1)[1].split("## 22. ", 1)[0]
    doc_tags = {}
    for line in tag_section.splitlines():
        cells = [cell.strip() for cell in line.split("|")[1:-1]]
        if len(cells) != 4:
            continue
        for index in [0, 2]:
            if cells[index + 1].isdigit() and cells[index] != "合計":
                doc_tags[cells[index]] = int(cells[index + 1])
    inventory_tags = Counter(op["primary_tag"] for op in inventory["operations"])
    require(doc_tags == inventory_tags, "Main tag table differs from inventory")

    for file in [ROOT / "README.md", ROOT / "CODEX_HANDOFF.md",
                 ROOT / "Immich_MCP_v3.3.5_Specification.md"]:
        text = file.read_text(encoding="utf-8")
        require(len(re.findall(r"^\x60{3}", text, re.M)) % 2 == 0, "Unbalanced fence: " + file.name)
        require("/workspace/" not in text, "Ephemeral path in document: " + file.name)
        require("turn35view" not in text, "Tool citation ID in artifact")
    for block in re.findall(r"\x60{3}mermaid\n(.*?)\x60{3}", main_text, re.S):
        require("<br" not in block and "click " not in block, "Unsupported Mermaid content")

    verification = subprocess.run(
        [sys.executable, str(ROOT / "api/verify_openapi_inventory.py")],
        check=True, text=True, capture_output=True,
    )
    upstream_report = json.loads(verification.stdout)
    require(upstream_report["ok"], "Inventory verifier failed")
    report = {
        "ok": True,
        "verification_scope": "specification_package_consistency_only",
        "not_application_runtime_or_live_server_test": True,
        "version": "3.3.5",
        "source_commit": EXPECTED_COMMIT,
        "openapi_sha256": EXPECTED_SHA,
        "operations": len(triples),
        "paths": len(spec["paths"]),
        "primary_tags": len(inventory_tags),
        "openapi_reference_occurrences_resolved": len(refs),
        "override_operations": len(override_ops),
        "secret_schema_rules": len(overrides["secret_field_rules"]),
        "secret_instance_bindings": secret_bindings,
        "mcp_tools": len(tools),
        "tool_schema_local_references_and_required_fields_checked": True,
        "full_json_schema_metaschema_validation_performed": False,
        "main_specification_chapters": len(headings),
        "json_files_parsed": verified_json_files,
        "live_immich_tested": False,
        "chatgpt_connection_tested": False,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
