#!/usr/bin/env python3
"""
Process CloudFormation schemas for cfn2iam tool
Downloads, extracts, and processes schemas to minimal format
"""

import json
import os
import glob
import shutil
import urllib.request
import zipfile
from pathlib import Path


def download_and_process_schemas():
    """Download and process CloudFormation schemas"""

    print("Downloading CloudFormation schemas...")
    try:
        urllib.request.urlretrieve(
            "https://schema.cloudformation.eu-central-1.amazonaws.com/CloudformationSchema.zip",
            "schemas.zip",
        )
        print("Download completed")
    except Exception as e:
        print(f"Download failed: {e}")
        return False

    print("Extracting schemas...")
    try:
        with zipfile.ZipFile("schemas.zip", "r") as zip_ref:
            zip_ref.extractall("temp/")
        print("Extraction completed")
    except Exception as e:
        print(f"Extraction failed: {e}")
        return False

    # Create schemas directory
    schemas_dir = Path("schemas")
    schemas_dir.mkdir(exist_ok=True)

    # Process each JSON file
    processed_count = 0
    error_count = 0

    print("Processing schema files...")

    for file_path in glob.glob("temp/*.json"):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # Get typeName for filename
            type_name = data.get("typeName")
            if not type_name:
                print(f"Skipping {file_path}: No typeName found")
                continue

            # Skip non-AWS resources
            if not type_name.startswith("AWS::"):
                continue

            # Create minimal schema with only needed fields
            minimal_schema = {
                "typeName": type_name,
                "handlers": data.get("handlers", {}),
            }

            # Save with typeName as filename (safe filename)
            safe_filename = type_name.replace("::", "_").replace("/", "_")
            output_file = schemas_dir / f"{safe_filename}.json"

            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(minimal_schema, f, indent=2, sort_keys=True)

            processed_count += 1

        except Exception as e:
            error_count += 1
            print(f"Error processing {file_path}: {e}")

    # Cleanup
    print("Cleaning up temporary files...")
    shutil.rmtree("temp", ignore_errors=True)
    if os.path.exists("schemas.zip"):
        os.remove("schemas.zip")

    print(f"Processing completed!")
    print(f"Processed: {processed_count} schemas")
    if error_count > 0:
        print(f"Errors: {error_count} files")

    # Create index file for quick reference
    create_schema_index(schemas_dir)

    return True


def create_schema_index(schemas_dir):
    """Create an index file listing all available schemas"""

    print("Creating schema index...")

    index = {"lastUpdated": None, "totalSchemas": 0, "schemas": []}

    try:
        from datetime import datetime, timezone

        index["lastUpdated"] = datetime.now(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )

        schema_files = list(schemas_dir.glob("*.json"))
        index["totalSchemas"] = len(schema_files)

        for schema_file in sorted(schema_files):
            try:
                with open(schema_file, "r", encoding="utf-8") as f:
                    schema_data = json.load(f)

                index["schemas"].append(
                    {
                        "typeName": schema_data.get("typeName", ""),
                        "filename": schema_file.name,
                        "hasHandlers": bool(schema_data.get("handlers")),
                    }
                )

            except Exception as e:
                print(f"Error reading {schema_file}: {e}")

        # Save index
        with open(schemas_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(index, f, indent=2, sort_keys=True)

        print(f"Schema index created with {len(index['schemas'])} entries")

    except Exception as e:
        print(f"Error creating index: {e}")


if __name__ == "__main__":
    success = download_and_process_schemas()
    exit(0 if success else 1)
