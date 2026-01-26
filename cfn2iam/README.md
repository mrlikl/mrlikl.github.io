# CloudFormation to IAM Policy Generator

A client-side web tool that generates minimal IAM policies for CloudFormation stack deployment. Upload or paste your CloudFormation template and get the exact IAM permissions needed for deployment.

## 🚀 How It Works

1. **Template Analysis**: Parses CloudFormation templates (JSON/YAML)
2. **Resource Extraction**: Identifies all AWS resources in the template
3. **Schema Lookup**: Fetches resource schemas from local cache
4. **Permission Mapping**: Maps resource operations to IAM permissions
5. **Policy Generation**: Creates minimal IAM policy document

## 📋 Generated Policy Structure

The tool generates policies with two types of permissions:

- **Allow Statements**: Create, Update, Read, List permissions
- **Delete Statements**: Delete-only permissions (Allow or Deny based on user choice)

## 🔄 Schema Updates

CloudFormation schemas are automatically updated weekly via GitHub Actions:

- Downloads latest schemas from AWS
- Processes and optimizes for client-side use
- Creates pull requests for review
- Maintains schema index for quick lookups

## 🚦 Getting Started

1. Visit the tool at [https://mrlikl.github.io/cfn2iam/](https://mrlikl.github.io/cfn2iam/)
2. Upload a CloudFormation template or paste content
3. Click "Generate IAM Policy"
