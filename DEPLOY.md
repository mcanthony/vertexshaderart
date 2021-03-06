# Deploying

I hope it goes without saying but just in case, please don't be a jerk and release a site
that is nearly the same as vertexshaderart.com. If you have suggestions or want to add
features please [file an issue](http://github.com/greggman/vertexshaderart/issues) or
submit a pull request.

That said if you want to use this code as a basis for something new I hope this works
and will help you get started quickly.

### Prerequsites

*  Docker

   Install [Docker](http://docker.com)

*  OSX

   I'm sure this will work on Linux just fine it's just that Docker on OSX runs in a VM
   and these scripts assume you're on the host machine running the VM that's running
   docker.

   I'm sure this will work on Window just fine too, especially because docker runs everywhere
   but a few of the scripts I wrote outside of docker assume bash. Feel free to
   submit windows scripts

### SSH Keys

My ssh key setup is ... well, it doesn't match most instructions we seem to assume you have
just one key pair. Maybe one key pair is fine but I tend to have one key pair per service.

The deploy scripts currently assume there are public keys stored at `~/.ssh/id_rsa.localdocker.pub` and
`~/.ssh/id_rsa.digitalocean.pub`.

The way you make an SSH key is to type

    ssh-keygen -t rsa

When asked where to save I'd put something like

    Enter file in which to save the key (/Users/gregg/.ssh/id_rsa): /Users/gregg/.ssh/id_rsa.localdocker

Which will write both the private key `~/.ssh/id_rsa.localdocker` and the public key
`~/.ssh/id_rsa.localdocker.pub`

I then edit the file `~/.ssh/config`. In that file I have lines like this

    # IP address of digital ocean droplet so I can access it without a domain name
    Host 159.203.113.253
      IdentityFile ~/.ssh/id_rsa.digitalocean
      User root

    # local docker VM
    Host 192.168.99.100
      IdentityFile ~/.ssh/id_rsa.localdocker
      User docker

    # name of service once the domain name is up
    Host vertexshaderart.com
      IdentityFile ~/.ssh/id_rsa.digitalocean
      User root

This does two things. #1 it makes me not have to type a password to log into docker nor my droplet
on digital ocean. #2 it sets my user name so I can type `ssh vertexshaderart.com` instead of `ssh root@vertexshaderart.com`

### Deploy Locally

I'm pretty sure this will work though I haven't tested it on a fresh machine

1.  Copy the file `server/deploy/settings-local-orig.json` to `server/deploy/settings-local.json`

        cp server/deploy/settings-local-orig.json server/deploy/settings-local.json

    **IMPORTANT!! DO NOT ADD THIS FILE TO GIT!!**

2.  edit the file `server/deploy/docker-compose-local.yml` and change this line

        - REPO=https://github.com/greggman/vertexshaderart

    to be the location of your github repo for your new project.

3.  Start a docker terminal.

    On OSX that's done by running `Docker Quickstart Terminal` which is in `Appliations/Docker`.

    On Linux that's probably just opening a terminal

4.  cd to the `server/deploy` folder and type

        ./push-local.sh

    **NOTE: You'll probably see several errors at the beginning.**

    It will then download a bunch of docker image data and finally
    spin up docker containers in a VM

    You may be asked for a password for docker. The default password
    is `tcuser`.

5.  type

        ssh 192.168.99.100 'docker logs -f c_meteor_1'

    This will show you output from the docker container running
    meteor. Once you see "Starting Meteor..." (or if you see
    "Building the Bundle..." and you've waited 3-5 mins) then...

6.  Go to `http://192.168.99.100:3000`

    If you see the website it's running. There's no data so there
    will be no art to view. You'll need to make some

To update the local VM check stuff into your github repo and run steps 4+ again.

### Deploy Live

I used Digital Ocean but I'm going to guess any service that supports
Docker will be about the same.

Log into Digital Ocean and add your public (the id_rsa.xxx.pub file) ssh keys.
This is important as it's way way more secure than passwords and it means you won't be
asked for passwords a billion times as you run these scripts.

1.  make a new droplet. I used a 1gig droplet.

2.  Under "Select Image" click the "Applications" tab and pick the docker image.

3.  Under "Add SSH Key" pick your key you uploaded

4.  Click "Create Droplet".

    Note the IP address for the new droplet.

    Test it by typing

        ssh <ipaddress>

    It should connect to your droplet no questions asked. If it doesn't then you either
    didn't setup your ssh keys or something else is wrong. Type `exit` to exit or press Ctrl-D.

5.  Copy the file `server/deploy/settings-live-orig.json` to `server/deploy/settings-live.json`

        cp server/deploy/settings-live-orig.json server/deploy/settings-live.json

    **IMPORTANT!! DO NOT ADD THIS FILE TO GIT!!**

6.  Edit the file `server/deploy/docker-compose-live.yml` and change these lines

        - REPO=https://github.com/greggman/vertexshaderart
        - ROOT_URL=http://www.vertexshaderart.com

    The first line needs to be the location of your github repo for your new project.
    The second like needs to be the place your site can be reached. If you haven't setup
    a domain name use your droplets ip address. (eg: `- ROOT_URL=http://123.234.12.34`)

7.  Edit the file `server/deploy/push-live.sh`

    Change `DOCKER=vertexshaderart.com` to the IP address or domain of your droplet.

8.  cd to the `server/deploy` folder and type

        ./push-live.sh

9.  type

        ssh <ipaddress-of-drople> 'docker logs -f c_meteor_1'

    This will show you output from the docker container running
    meteor. Once you see "Starting Meteor..." ..

10. Go to `http://<ipaddresofdroplet>`

    Your site is live.

To update the site check stuff into your github repo and run steps 8+ again

#### Configuring login services

Each service you want to support needs a 2 codes. A public code identifying
your app/website to the service and a private code or secret used for authentication.

These are set in `server/deploy/settings-live.json` and `server/deploy/settings-local.json`.

**IMPORTANT!! DO NOT CHECK THESE CHANGES INTO GIT!!!**

For me I copied the entire folder, `server/deploy`, to some other folder outside of my workarea
and I run them from over there. That way I can not accidentally check in my
secrets into git.

To get a key and and secret for each service you need to login to each service
and apply for one.

##### Github

*   Visit https://github.com/settings/applications/new
*   Set Homepage URL to: `http://<ipaddressofdroplet-or-domain>/`
*   Set Authorization callback URL to: `http://<ipaddressofdroplet-or-domain>/_oauth/github`

##### Google

*   Visit https://console.developers.google.com/
*   "Create Project", if needed. Wait for Google to finish provisioning.
*   On the left sidebar, go to "APIs & auth" and, underneath, "Consent Screen". Make sure to enter an email address and a product name, and save.
*   On the left sidebar, go to "APIs & auth" and then, "Credentials". "Create New Client ID", then select "Web application" as the type.
*   Set Authorized Javascript Origins to: `http://<ipaddressofdroplet-or-domain>/`
*   Set Authorized Redirect URI to: `http://<ipaddressofdroplet-or-domain>/_oauth/google`
*   Finish by clicking "Create Client ID".

##### Soundcloud

*   Visit http://soundcloud.com/you/apps/new
*   Set Redirect URI to: `http://<ipaddressofdroplet-or-domain>/_oauth/soundcloud?close`

##### Twitter

*   Visit https://dev.twitter.com/apps/new
*   Set Website to: `http://<ipaddressofdroplet-or-domain>/`
*   Set Callback URL to: `http://<ipaddressofdroplet-or-domain>/_oauth/twitter?close`
*   Select "Create your Twitter application".
*   On the Settings tab, enable "Allow this application to be used to Sign in with Twitter" and click "Update settings".
*   Switch to the "Keys and Access Tokens" tab.

##### Live vs Local

If I understand correctly the callback for each URL needs to be accessable from the browser
which means you either need to edit them all for live vs local or else register separate apps
for each service (mysite and mysite-dev).  Every where it says `<ipaddressofdroplet-or-domain>`
above would be `192.168.99.100:3000` for local. Personally I haven't set any up for local

#### Configuring Google Analytics

Edit `server/deploy/settings-live.json` and change the account #

    "ga": {
      "id":"UA-XXXXXXXX-X"
    },

### Backup and Restore

make a folder `backups` in `server/deploy`

    cd server/deploy
    mkdir backups

Edit `backup-live.sh` and `restore-live.js` and change `DOCKER=vertexshaderart.com` to
`DOCKER=<ipaddresofdroplet-or-domain>`

To backup type

    ./backup-live.sh

This will connect the meteor container inside your docker droplet runnin on digital ocean.
It will dump the database and make a tar.gz for it. It will then also make a tar.gz for
all the images. Finally it will use scp to download both of those files and copy them
into `backups` with the date inserted in the name

To restore type

    ./restore-live.sh <date-of-backup-to-restore>

You can also backup and restore the local docker version with `./backup-local.sh` and `./restore-local.sh`.

For testing and debugging it's common for me to backup the live site and restore to the local site. At that
point the 2 should be identical.

I don't currently have a way to restore to the local OSX version (the one running in server/vertexshaderart vs the one
running in a local docker VM). It would be easy enough to add but I find that the one running 100% local, no docker,
has lots of test data in it so I haven't had a reason to backup or restore that yet.
















