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

        console.log("hook received: req parameter:"+req.param[0]) ;
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

        /* giturl */


       if (config.gh_server.startsWith("gitlab.")) {
            //Git URLs for gitlab enterprise
           if (config.public_repo) {
              params.push(data.repository.git_http_url);
           } else {
              params.push(data.repository.git_ssh_url);
           }
        }
        else if (config.gh_server.startsWith("github")) {
            //Git URLs for github enterprise
           if (config.public_repo) {
              params.push(data.repository.clone_url);
           } else {
              params.push(data.repository.ssh_url);
           }
            
        }
	    else {
           if (config.public_repo) {
              params.push('https://' + config.gh_server + '/' + data.owner + '/' + data.repo + '.git');
           } else {
               params.push('git@' + config.gh_server + ':' + data.owner + '/' + data.repo + '.git');
           }
	    }

        var base_dir = config.temp ;
        if (!path.isAbsolute(base_dir))
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;
        /* source */ params.push(base_dir + '/' + data.owner + '/' + data.repo + '/' + data.branch + '/' + 'code');
        /* build  */ params.push(base_dir + '/' + data.owner + '/' + data.repo + '/' + data.branch + '/' + 'site');

        /* editurl template*/ params.push(getEditPageUrl(config, data)) ;

        var base_dir = config.serve.doc_root ;
        if (!path.isAbsolute(base_dir))
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;
        /* publish path */ params.push(base_dir +'/'+config.project_mappings[data.repo].short_name) ;


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

//setup our static site server for all sites defined in the config.json
setupDocServer(app) ;

// Start server
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
function setupDocServer(app) {
    sites = configSet.sites ;
    for (i = 0 ; i < sites.length; i++) {
        cfg = sites[i] ;

        var base_dir = cfg.serve.doc_root ;
        if (!path.isAbsolute(base_dir)) 
            base_dir = path.normalize(path.join(__dirname , base_dir)) ;
        app.use(cfg.serve.doc_root_url_path, express.static(base_dir)) ;
    }    
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
