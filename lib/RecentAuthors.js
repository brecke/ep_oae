/*!
 * Copyright 2013 Apereo Foundation (AF) Licensed under the
 * Educational Community License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may
 * obtain a copy of the License at
 *
 *     http://www.osedu.org/licenses/ECL-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an "AS IS"
 * BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express
 * or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 */

var _ = require('ep_etherpad-lite/node_modules/underscore');

var PadMessageHandler = require('ep_etherpad-lite/node/handler/PadMessageHandler');

var MQ = require('./MQ');

/*
 * Maps an object containing the recent authors (and the last time they made an edit) to a pad ID
 *
 * ```
 * {
 *     "pad:foo": {
 *         "a.kfjsklf": {"time": 123, "edit": false, "user": "u:cam:simong", "contentId": "c:cam:abc"},
 *         "a.nnmxcc": {"time": 756, "edit": true, "user": "u:cam:nico", "contentId": "c:cam:abc"}
 *     },
 *     "pad:bar": {
 *         "a.nnmxcc": {"time": 1456, "edit": false, "user": "u:cam:nico", "contentId": "c:cam:def"}
 *     }
 * }
 * ```
 */
var recentAuthors = {};

// The interval (in ms) when we should check if a user left the pad and notify OAE
var INTERVAL = 60 * 1000;

// The amount of time (in ms) after which we consider a user left the pad. This timespan
// should only be used in extra-ordinary situations to prevent memory leaks
var TTL = 24 * 60 * 60 * 1000;

/**
 * Set up a user in the recent authors list for a pad.
 *
 * @param  {String}     padId       The identifier of the pad that was joined
 * @param  {String}     authorId    The Etherpad author ID who joined
 * @param  {String}     userId      The OAE user ID who joined
 * @param  {String}     contentId   The OAE content ID of the pad the user joined
 */
var join = module.exports.join = function(padId, authorId, userId, contentId) {
    // Create an entry for this pad if necessary
    recentAuthors[padId] = recentAuthors[padId] || {}

    // Create an entry for this author in this pad if necessary
    recentAuthors[padId][authorId] = recentAuthors[padId][authorId] || {
        'edit': false,
        'time': Date.now(),
        'userId': userId,
        'contentId': contentId
    };
};

/**
 * Mark a user as an editor of a pad
 *
 * @param  {String}     padId       The etherpad pad id
 * @param  {String}     authorId    The etherpad user id
 */
var madeEdit = module.exports.madeEdit = function(padId, authorId) {
    if (recentAuthors[padId] && recentAuthors[padId][authorId]) {
        recentAuthors[padId][authorId].edit = true;
        recentAuthors[padId][authorId].time = Date.now();
    }
};

/**
 * Remove a user from a pad. If this user made any edits
 * a message will be sent to OAE indicating this modification
 *
 * @param  {String}     padId       The etherpad pad id
 * @param  {String}     authorId    The etherpad user id
 */
var leave = module.exports.leave = function(padId, authorId) {
    if (recentAuthors[padId] && recentAuthors[padId][authorId]) {
        // If the author made an actual edit, we'll trigger a publish event
        if (recentAuthors[padId][authorId].edit &&
            recentAuthors[padId][authorId].userId &&
            recentAuthors[padId][authorId].contentId) {
            MQ.publish(recentAuthors[padId][authorId].contentId, recentAuthors[padId][authorId].userId);
        }

        // Remove the author's entry
        delete recentAuthors[padId][authorId];
    }

    // If the last author just left the pad, we clean up the entry for this pad
    if (_.isEmpty(recentAuthors[padId])) {
        delete recentAuthors[padId];
    }
};

/**
 * Check if an author has left the pad
 *
 * @param  {String}     padId               The etherpad pad id
 * @param  {String}     authorId            The etherpad user id
 * @param  {Function}   callback            Standard callback function
 * @param  {Object}     callback.err        An error object, if any
 * @param  {Boolean}    callback.hasLeft    Whether or not the user has left the pad
 * @api private
 */
var _hasLeft = function(padId, padUsers, authorId, callback) {
    // If we can't find the user in the list of pad users, he has left
    var padUser = _.find(data.padUsers, function(user) { return (user.id === authorId); });
    return (!padUser);
};

/**
 * Iterate over all the pads and their users and check if the user is still
 * in the pad. If he is not, we will remove his user info object. In case the
 * user made any edits to the pad, OAE will be notified of the change so an
 * appropriate activity can be published in the activity stream and a revision
 * can be created.
 *
 * In case the users for a pad can't be determined we'll allow for a certain TTL
 * after which we we'll remove users.
 *
 * @api private
 */
var checkForLeftUsers = function() {
    _.each(recentAuthors, function(pad, padId) {
        PadMessageHandler.padUsers(padId, function(err, data) {
            if (err) {
                console.error('Could not determine pad users for %s. This could lead to a memory leak!', padId, err);
            }

            _.each(pad, function(authorInfo, authorId) {
                // Check if the user has left the pad
                var padUser = _.find(data.padUsers, function(user) { return (user.id === authorId); });
                var hasLeft = !padUser;

                // Calculate how long ago a user made an edit, if it's been longer
                // than `TTL` we remove the user to avoid memory leaks
                var timeSinceEdit = now - authorInfo.time;

                if (hasLeft || (timeSinceEdit > TTL)) {
                    leave(padId, authorId);
                }
            });
        });
    });
};

// Clean up the authors periodically
setInterval(checkForLeftUsers, INTERVAL);
