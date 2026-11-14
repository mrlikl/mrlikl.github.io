# mrlikl.github.io

Source of [mrlikl.github.io](https://mrlikl.github.io), a portfolio site, and of two small browser tools hosted on it.

## Tools

### [cfn2iam](./cfn2iam/): stop deploying CloudFormation with AdministratorAccess

Reads a CloudFormation or SAM template and generates the IAM policy the stack needs to deploy, before the first deploy. IAM Access Analyzer policy generation works from CloudTrail activity, so it needs a broad-permission deploy first; cfn2iam reads the template instead. The policy is limited to actions (`"Resource": "*"`); see the [README](./cfn2iam/README.md) for scope and limitations.

- Live: [mrlikl.github.io/cfn2iam](https://mrlikl.github.io/cfn2iam/)
- Command-line version: [github.com/mrlikl/cfn2iam](https://github.com/mrlikl/cfn2iam) and [PyPI](https://pypi.org/project/cfn2iam/)

### [ec2prices](./ec2prices/): EC2 on-demand prices by region

Compares EC2 Linux on-demand prices for every instance type across regions, from the AWS Price List API.

- Live: [mrlikl.github.io/ec2prices](https://mrlikl.github.io/ec2prices/)
