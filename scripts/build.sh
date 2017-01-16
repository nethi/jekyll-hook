#!/bin/bash
set -e

# This script is meant to be run automatically
# as part of the jekyll-hook application.
# https://github.com/developmentseed/jekyll-hook

repo=$1
branch=$2
owner=$3
giturl=$4
source=$5
build=$6

#edit page URL template
editpage=$7

#site path to publish (for local publishing)
site=$8

# Check to see if repo exists. If not, git clone it
if [ ! -d $source ]; then
    git clone $giturl $source
fi

# Git checkout appropriate branch, pull latest code
cd $source
git checkout $branch
git pull origin $branch
cd -


# Run jekyll
cd $source
[ -f Gemfile ] && (bundle check || bundle install)
EDIT_URL_TEMPLATE=$7 bundle exec jekyll build -s $source -d $build
cd -
