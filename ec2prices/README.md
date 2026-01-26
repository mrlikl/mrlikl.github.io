# AWS EC2 Linux On-Demand Pricing Website

A static website that displays current AWS EC2 Linux On-Demand pricing information across multiple regions. The site is automatically updated weekly using GitHub Actions.

## 🌐 Live Website

The website is hosted on GitHub Pages at [https://mrlikl.github.io/ec2prices](https://mrlikl.github.io/ec2prices)

## 🔧 Components

### Data Collection (`data.py`)
- Fetches EC2 pricing data from AWS Price List API
- Processes and formats pricing information

### Static Site Generation (`generate_static.py`)
- Converts Flask templates to static HTML
- Formats HTML output for better readability
- Manages timestamp updates for data freshness tracking

### Development Server (`webapp.py`)
- Flask-based development server
- Jinja2 templating with custom globals
- Local testing and development support

## 📁 Project Structure

```
├── index.html              # Generated static website
├── source/                 # Source code and templates
│   ├── data.py            # AWS pricing data collection
│   ├── webapp.py          # Flask application for development
│   ├── generate_static.py # Static site generator
│   ├── requirements.txt   # Python dependencies
│   └── templates/         # Jinja2 templates
├── static/                # CSS and static assets
└── .gitignore            # Git ignore rules
```


## 🚀 Automated Updates

The website is automatically updated every 7 days through GitHub Actions

Previous workflow:
1. **EventBridge Schedule**: Triggers weekly at a specified time
2. **CodeBuild Project**: 

Executes the source and creates the PR 
```
version: 0.2
env:
  variables:
    HOME: /root
    BRANCH: "main"
  secrets-manager:
    GITHUB_TOKEN: "github-secret-name-placeholder"

phases:
  pre_build:
    commands:
      - echo "Setting up Git configuration"
      - git config --global user.email "codebuild@aws.com"
      - git config --global user.name "AWS CodeBuild"
      - git config --global credential.helper store
      - echo "https://$GITHUB_TOKEN:x-oauth-basic@github.com" > /root/.git-credentials
      
  build:
    commands:
      - git clone https://github.com/mrlikl/mrlikl.github.io.git
      - cd mrlikl.github.io
      - git remote set-url origin https://$GITHUB_TOKEN@github.com/mrlikl/mrlikl.github.io.git
      - cd source
      - pip3 install -r requirements.txt
      - python3 data.py
      - python3 generate_static.py
      - echo "Checking for changes"
      - cd ..
      - |
        if git diff --quiet index.html; then
          echo "No changes detected in index.html - pricing data is up to date"
          exit 0
        else
          echo "Changes detected in index.html, creating PR"
          BRANCH_NAME="pricing-update-$(date +%Y%m%d-%H%M%S)"
          git checkout -b $BRANCH_NAME
          git add index.html
          git commit -m "Automated pricing data update - $(date +%Y-%m-%d)"
          git push origin $BRANCH_NAME
          python3 source/create_pr.py $BRANCH_NAME
        fi
```
