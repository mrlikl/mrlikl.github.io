import json
import re
import os
import requests

regions = [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'ap-south-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'eu-central-1',
    'eu-west-1',
    'ca-central-1'
]

region_code = {
    'us-east-1': {
        'prefix': ''
    },
    'us-east-2': {
        'prefix': 'USE2-'
    },    
    'us-west-1': {
        'prefix': 'USW1-'
    },
    'us-west-2': {
        'prefix': 'USW2-'
    },
    'ap-south-1': {
        'prefix': 'APS3-'
    },
    'ap-southeast-1': {
        'prefix': 'APS1-'
    },
    'ap-southeast-2': {
        'prefix': 'APS2-'
    },
    'eu-central-1': {
        'prefix': 'EUC1-'
    },
    'eu-west-1': {
        'prefix': 'EU-'
    },
    'ca-central-1': {
        'prefix': 'CAN1-'
    }
}

base_url = "https://pricing.us-east-1.amazonaws.com"


def check_and_update_file(region, version_from_url):
    filename = f"master/{region}.json"
    if os.path.exists(filename):
        with open(filename, 'r') as file:
            try:
                data = json.load(file)
                existing_version = data.get('version')
                if existing_version == version_from_url:
                    print(f"File {filename} is up to date.")
                    return False
                else:
                    print(f"File {filename} is outdated. Updating...")
            except json.JSONDecodeError:
                print(f"Error reading {
                      filename}. Will download a new version.")
    else:
        print(f"File {filename} does not exist. Will download.")
    return True


def load_data():
    for region in regions:
        with open("region_index.json", "r") as file:
            region_data = json.load(file)

        current_version_url = region_data['regions'][region]['currentVersionUrl']
        version_from_url = current_version_url.split('/')[5]
        if check_and_update_file(region, version_from_url):
            url = base_url+region_data['regions'][region]['currentVersionUrl']
            folder_path = "master"
            if not os.path.exists(folder_path):
                os.makedirs(folder_path)

            print(url)
            response = requests.get(url)

            file_path = os.path.join(folder_path, region+".json")
            with open(file_path, "wb") as file:
                file.write(response.content)
            print(f"File saved as {file_path}")


def refresh_region_index():
    index_url = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json"
    response = requests.get(index_url)
    data = response.json()
    current_version_url = data['offers']['AmazonEC2']['currentRegionIndexUrl']
    ec2_region_index = base_url+current_version_url
    response = requests.get(ec2_region_index)
    data = response.json()

    with open("region_index.json", "w") as file:
        json.dump(data, file, indent=4)


print("--Refresh region index--")
refresh_region_index()
print("--Refreshed region index--")
print("--Loading data--")
load_data()
print("--Data loaded--")
print("--Processing data--")

for region in regions:
    folder_path = "master"
    file_path = os.path.join(folder_path, region+".json")
    with open(file_path, "r") as file:
        data = json.load(file)

    filtered_data = {}
    price_data = {}

    def find_on_demand_linux_prices(data):
        on_demand_linux_pattern = re.compile(
            r'\$(\d+\.?\d*) per On Demand Linux (.*?) Instance Hour')

        for top_level_key, value in data.items():
            for term_data in value.values():
                for dimension_data in term_data.get("priceDimensions", {}).values():
                    description = dimension_data["description"]
                    match = on_demand_linux_pattern.match(description)
                    if match:
                        price = float(match.group(1))
                        price_data[top_level_key] = price

    find_on_demand_linux_prices(data['terms']['OnDemand'])

    for product_id, product_data in data.get("products", {}).items():
        attributes = product_data.get("attributes", {})
        instance_type = attributes.get("instanceType")
        if region_code[region]['prefix'] != '':
            usage_type_match = region_code[region]['prefix'] + \
                "BoxUsage:" + str(instance_type)
        else:
            usage_type_match = "BoxUsage:" + str(instance_type)
        if attributes.get("operatingSystem") == "Linux" and attributes.get("operation") == "RunInstances" and attributes.get("usagetype") == usage_type_match:
            filtered_data[instance_type] = price_data[product_id]

    result_prefix = 'results'
    if not os.path.exists(result_prefix):
        os.makedirs(result_prefix)

    file_path = os.path.join(result_prefix, region+".json")
    with open(file_path, "w") as output_file:
        json.dump(filtered_data, output_file, indent=4)

    print("Data saved to "+file_path)
