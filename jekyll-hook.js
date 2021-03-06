#!/usr/bin/env node

var configSet  = require('./config.json');
var fs      = require('fs');
var path      = require('path');
var express = require('express');
var app     = express();
var queue   = require('queue-async');
var tasks   = queue(1);
var spawn   = require('child_process').spawn;
var email   = require('emailjs/email');
var crypto  = require('crypto');
var urllib = require('url') ;

config = configSet.sites[0] ;
function getConfig(url) {
    host = urllib.parse(url).hostname ;
    sites = configSet.sites ;
    cfg = null ;
    for (i = 0 ; i < sites.length; i++) {
        if (sites[i].gh_server.startsWith(host)) {
            cfg = sites[i] ;
            break;
        }
    }
    return cfg ;
}

app.use(express.bodyParser({
    verify: function(req,res,buffer){
        if(!req.headers['x-hub-signature']){
            return;
        }

        var data = req.body;
        url = data.repository.url ;
        config = getConfig(url) ;
        if(!config.secret || config.secret==""){
            console.log("Recieved a X-Hub-Signature header, but cannot validate as no secret is configured");
            return;
        }

        var hmac         = crypto.createHmac('sha1', config.secret);
        var recieved_sig = req.headers['x-hub-signature'].split('=')[1];
        var computed_sig = hmac.update(buffer).digest('hex');

        if(recieved_sig != computed_sig){
            console.warn('Recieved an invalid HMAC: calculated:' + computed_sig + ' != recieved:' + recieved_sig);
            var err = new Error('Invalid Signature');
            err.status = 403;
            throw err;
        }
    }

}));

// Receive webhook post
app.post('/hooks/jekyll/*', function(req, res) {
    // Close connection
    res.send(202);

    // Queue request handler
    tasks.defer(function(req, res, cb) {
        var data = req.body;
        var branch = req.params[0];
        var params = [];

        console.log("hook received: req parameter:"+req.params[0]) ;
        console.log("hook received:"+ JSON.stringify(data)) ;
        // Parse webhook data for internal variables
        data.repo = data.repository.name;
        data.branch = data.ref.replace('refs/heads/', '');
        data.owner =  data.repository.owner ? data.repository.owner.name : data.project.namespace;

        url = data.repository.homepage || data.repository.url ;
        console.log("webhook repo url:"+url) ;
        config = getConfig(url) ;
        console.log("config returned:"+config.gh_server) ;

        if (!config || !config.project_mappings[data.repo]) {
            console.log("Couldn't find a matching project definition for:"+data.repo) ;
            return ;
        }

        //find project settings for this webhook's project
        project = findProject(config, data.repo) ;

        // End early if not permitted account
        // RN+ With project-mappings, this is not required
        //if (config.accounts.indexOf(data.owner) === -1) {
        //    console.log(data.owner + ' is not an authorized account.');
        //    if (typeof cb === 'function') cb();
        //    return;
        //}

        // End early if not permitted branch
        branchArray = data.ref.split("/")
        if (branchArray[branchArray.length - 1] !== branch.substring(1, branch.length)) {
            console.log('Not ' + branch + ' branch.');
            if (typeof cb === 'function') cb();
            return;
        }

        // Process webhook data into params for scripts
        /* repo   */ params.push(data.repo);
        /* branch */ params.push(data.branch);
        /* owner  */ params.push(data.owner);

        /* giturl for cloning */
        //First, check if we have a clone URL specified, otherwise construct one.
       clone_url = getCloneUrl(config, data) ;

       if (!clone_url) {
        if (config.gh_server.startsWith("gitlab.")) {
                //Git URLs for gitlab enterprise
            if (config.public_repo) {
                clone_url = data.repository.git_http_url ;
            } else {
                clone_url = data.repository.git_ssh_url ;
            }
            }
            else if (config.gh_server.startsWith("github")) {
                //Git URLs for github enterprise
                if (config.public_repo) {
                    clone_url = data.repository.clone_url ;
                } else {
                    clone_url = data.repository.ssh_url ;
                }
                
            }
            else {
                if (config.public_repo) {
                    clone_url = 'https://' + config.gh_server + '/' + data.owner + '/' + data.repo + '.git' ;
                } else {
                    clone_url = 'git@' + config.gh_server + ':' + data.owner + '/' + data.repo + '.git' ;
                }
            }
       }
       params.push(clone_url) ;

        var base_dir = config.temp ;
        if (!path.isAbsolute(base_dir))
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;

        /* source */ params.push(base_dir + '/' + data.owner + '/' + data.repo + '/' + data.branch + '/' + 'code');
        /* build  */ params.push(base_dir + '/' + data.owner + '/' + data.repo + '/' + data.branch + '/' + 'site');

        /* editurl template*/ params.push(getEditPageUrl(config, data)) ;

        var base_dir = project.doc_root ;
        if (!path.isAbsolute(base_dir))
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;
        base_dir = path.join(base_dir, project.short_name) ;    
        /* publish path */ params.push(base_dir) ;


        // Script by branch.
        var build_script = null;
        try {
          build_script = config.scripts[data.branch].build;
        }
        catch(err) {
          try {
            build_script = config.scripts['#default'].build;
          }
          catch(err) {
            throw new Error('No default build script defined.');
          }
        }
        
        var publish_script = null;
        try {
          publish_script = config.scripts[data.branch].publish;
        }
        catch(err) {
          try {
            publish_script = config.scripts['#default'].publish;
          }
          catch(err) {
            throw new Error('No default publish script defined.');
          }
        }


        // Run build script
        run(build_script, params, function(err) {
            if (err) {
                console.log('Failed to build: ' + data.owner + '/' + data.repo);
                send(config, 'Your website at ' + data.owner + '/' + data.repo + ' failed to build.', 'Error building site', data);

                if (typeof cb === 'function') cb();
                return;
            }

            // Run publish script
            run(publish_script, params, function(err) {
                if (err) {
                    console.log('Failed to publish: ' + data.owner + '/' + data.repo);
                    send(config, 'Your website at ' + data.owner + '/' + data.repo + ' failed to publish.', 'Error publishing site', data);

                    if (typeof cb === 'function') cb();
                    return;
                }

                // Done running scripts
                console.log('Successfully rendered: ' + data.owner + '/' + data.repo);
                send(config, 'Your website at ' + data.owner + '/' + data.repo + ' was successfully published.', 'Successfully published site', data);

                if (typeof cb === 'function') cb();
                return;
            });
        });
    }, req, res);

});

//setup our static site server for all sites/projects defined in the config.json
setupDocServers(configSet) ;

// Start server to receive webhooks
var port = process.env.PORT || 8080;
app.listen(port);
console.log('Listening on port ' + port);


function findProject(cfg, name) {
    mappings = cfg.project_mappings ;
    return mappings[name] ;    
}
function getEditPageUrl(cfg, data) {
    url = cfg.edit_url_template ;

    url = url.replace(/\${repo_server}/g, cfg.gh_server) ;
    url = url.replace(/\${repo_owner}/g, data.repo) ;
    url = url.replace(/\${repo_name}/g, data.repo) ;
    url = url.replace(/\${repo_branch}/g, data.branch) ;
    return url ;
}
function getCloneUrl(cfg, data) {
    url = cfg.clone_url ;
    if (url) {
        url = url.replace(/\${repo_server}/g, cfg.gh_server) ;
        url = url.replace(/\${repo_owner}/g, data.repo) ;
        url = url.replace(/\${repo_name}/g, data.repo) ;
        url = url.replace(/\${repo_branch}/g, data.branch) ;
    }
    return url ;
}
function setupDocServer1(app) {
    sites = configSet.sites ;
    for (i = 0 ; i < sites.length; i++) {
        cfg = sites[i] ;

        var base_dir = cfg.serve.doc_root ;
        if (!path.isAbsolute(base_dir)) 
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;
        app.use(cfg.serve.doc_root_url_path, express.static(base_dir)) ;
    }    
}

function setupDocServers(config) {
    var sites = config.sites ;
    for (i = 0 ; i < sites.length; i++) {
        site_cfg = sites[i] ;

        console.log("Site:"+site_cfg.gh_server) ;
        var project ;
        for (name in  site_cfg.project_mappings) {
            project = site_cfg.project_mappings[name] ;

            //for each project setup the doc server
            //for now,  the ports should be unique for each project - will enhance it later
            var base_dir = project.doc_root ;
            if (!path.isAbsolute(base_dir)) 
                base_dir = path.normalize(path.join(__dirname , base_dir)) ;

            doc_root = project.doc_root
            if (!path.isAbsolute(doc_root) ) 
                doc_root = path.normalize(path.join(__dirname , doc_root)) ;
            doc_root = path.join(doc_root, project.short_name) ;    
            dapp = setupDocServer(project.name, project.doc_root_url_path, doc_root,
                                project.port) ;
        }                        
    }    
}
function setupDocServer(name, url_path, doc_root, port) {
    var dapp = express() ;

    console.log("Starting dock server for project:"+name+" on port:"+port+" & doc_root:"+doc_root);
    dapp.use(url_path, express.static(doc_root)) ;

    dapp.listen(port) ;
    return dapp ;
}


function run(file, params, cb) {
    var process = spawn(file, params);

    process.stdout.on('data', function (data) {
        console.log('' + data);
    });

    process.stderr.on('data', function (data) {
        console.warn('' + data);
    });

    process.on('exit', function (code) {
        if (typeof cb === 'function') cb(code !== 0);
    });
}

function send(config, body, subject, data) {
    if (config.email && config.email.isActivated && data.pusher.email) {
        var message = {
            text: body,
            from: config.email.user,
            to: data.pusher.email,
            subject: subject
        };
        var mailer  = email.server.connect(config.email);
        mailer.send(message, function(err) { if (err) console.warn(err); });
    }
}
